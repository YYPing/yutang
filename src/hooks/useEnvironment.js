import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_CITY, fetchWeather, lookupApproximateCity, getSeason, getDayPhase, getSolarTerm } from '../lib/environment.js';
import { readStore, writeStore, normalizeCity, normalizeWeather, readCachedWeather, weatherCacheKey, isWeatherFresh } from '../lib/storage.js';

/** 网络定位结果的保鲜期。到期后允许后台静默重新定位 —— 换了网络（家 / 公司 / 手机热点）
 *  能自己纠正过来，不用用户手动点。
 *  ★ 为什么不设更长：IP 归属只跟着**出口网络**变，6 小时足够覆盖"一天里的位置变化"，
 *    又不至于让用户觉得"我明明到新城市了，它还写着旧的"。 */
const LOCATION_TTL_MS = 6 * 60 * 60 * 1000;
/** 自动重试的退避档位：15 秒 → 1 分钟 → 5 分钟，三档用完就停下等用户点「重新定位」。
 *  ★ 为什么必须有上限：单源 5s、整条链总预算 12s，无上限重试等于对着断网死磕；
 *    而且每次重试都要新建一条 AbortController 链，越堆越乱。 */
const LOCATION_RETRY_MS = [15_000, 60_000, 5 * 60_000];
/** 「要不要重定位」的检查频率 —— 和天气刷新同频。检查本身只比一个时间戳，不走网络。 */
const LOCATION_CHECK_MS = 15 * 60 * 1000;
/** 定位彻底失败时的兜底文案。面板会直接把它显示给用户，所以必须是"人话"。 */
const LOCATION_FAILED_TEXT = '自动定位暂不可用，可手动搜索城市。';

/**
 * 网络定位的结果该刷新了吗。
 * ★ **没有时间戳也算过期** —— 那是从旧版本存档升上来的（当时还没记 `locatedAt`），
 *   恰好应该在下一次启动时刷一次，顺便把时间戳补上。
 */
function isLocationStale(city, now = Date.now()) {
  return !Number.isFinite(city?.locatedAt) || now - city.locatedAt >= LOCATION_TTL_MS;
}

export function useEnvironment(settings) {
  const [savedCity] = useState(() => normalizeCity(readStore('fusheng-city', null)));
  const [city, setCityState] = useState(() => savedCity ?? { ...DEFAULT_CITY });
  const [locationStatus, setLocationStatus] = useState(() => savedCity ? (savedCity.source === 'approximate' ? 'approximate' : 'saved') : 'locating');
  const [locationBusy, setLocationBusy] = useState(() => !savedCity);
  const [locationError, setLocationError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [snapshot, setSnapshot] = useState(() => {
    const data = readCachedWeather(city);
    return { key: weatherCacheKey(city), data, status: data ? 'cached' : 'loading' };
  });
  const request = useRef(null);
  const locationRequest = useRef(null);
  // 「武汉兜底」不是一个城市，是"还没有城市"。它一旦被真正的定位结果替换就永不再回来 ——
  // 于是"要不要把状态降级成 fallback"只需看这一个标记，不用再去猜当前城市是不是默认值。
  const placeholder = useRef(!savedCity);
  // 用户自己选过城市 = 自动定位以后不许再动它（只有他再点「重新定位」才例外）。
  const manualPick = useRef(!!savedCity && savedCity.source !== 'approximate');
  const locationAttempts = useRef(0);
  const locationRetry = useRef(null);
  // 退避窗口开着时，自动触发一律让位给定时器 —— 否则 focus / visibilitychange 会绕开退避，
  // 变成"一分钟里试十次"。用户点的按钮永远优先，不看这个标记。
  const locationBackoff = useRef(false);
  const activeCity = useRef(city);
  const selectionVersion = useRef(0);

  // Updating the ref and aborting synchronously closes the render/effect race:
  // a response for the previous city can never overwrite a new user selection.
  const setCity = useCallback((value) => {
    const next = normalizeCity(typeof value === 'function' ? value(activeCity.current) : value);
    if (!next) return;
    next.source = next.source === 'approximate' ? 'approximate' : 'manual';
    // ★ 不变式：`manualPick` ⇔ 当前城市**不是**按网络定位来的。
    //   用户手选 → true；定位结果落地 → false。所以"用户手选后再点「重新定位」成功了"
    //   会自动把城市交还给自动跟随，不需要额外分支去处理。
    manualPick.current = next.source !== 'approximate';
    selectionVersion.current += 1;
    request.current?.abort();
    locationRequest.current?.abort();
    clearTimeout(locationRetry.current);
    locationAttempts.current = 0;
    locationBackoff.current = false;
    placeholder.current = false;
    setLocationError(null);
    setLocationBusy(false);
    activeCity.current = next;
    const cached = readCachedWeather(next);
    setSnapshot({ key: weatherCacheKey(next), data: cached, status: 'loading' });
    setLocationStatus(next.source);
    setCityState(next);
    writeStore('fusheng-city', next);
  }, []);

  /**
   * 按 IP 定位并落地结果。**唯一的入口** —— 首启动、退避重试、时效到期、用户点按钮都走这里。
   *
   * ★ 为什么不写在面板里：面板一关就丢状态，而"重试次数 / 退避窗口"必须比面板活得久 ——
   *   否则关一次面板等于把退避清零，坏网络下会变成"关不掉的重试"。
   *
   * @param {{silent?: boolean, userInitiated?: boolean}} [options]
   *   `silent` 静默刷新（不闪「正在定位」、失败不弹错误）· `userInitiated` 用户点的按钮
   */
  const locate = useCallback(async ({ silent = false, userInitiated = false } = {}) => {
    if (manualPick.current && !userInitiated) return { ok: false, reason: 'manual' };
    if (!userInitiated && locationBackoff.current) return { ok: false, reason: 'backoff' };
    locationRequest.current?.abort();
    clearTimeout(locationRetry.current);
    const controller = new AbortController();
    locationRequest.current = controller;
    if (!silent) {
      setLocationBusy(true);
      setLocationError(null);
      if (placeholder.current) setLocationStatus('locating');
    }
    try {
      const result = await lookupApproximateCity({ signal: controller.signal });
      if (controller.signal.aborted || locationRequest.current !== controller) return { ok: false, reason: 'aborted' };
      // 等结果的这段时间里用户可能已经手动选了城市 —— 那就别覆盖他（点按钮来的除外，那是他刚要求刷新）。
      if (manualPick.current && !userInitiated) return { ok: false, reason: 'manual' };
      locationAttempts.current = 0;
      locationBackoff.current = false;
      // `locatedAt` 必须在这里盖 —— 它是下一次"该不该刷新"的唯一依据。
      setCity({ ...result, locatedAt: Date.now() });
      return { ok: true, city: result };
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || locationRequest.current !== controller) {
        return { ok: false, reason: 'aborted' };
      }
      setLocationBusy(false);
      const message = error instanceof Error && error.message ? error.message : LOCATION_FAILED_TEXT;
      // ★ 静默刷新失败**不报错**：用户没点任何东西，弹一条红字只会让人以为程序坏了。
      //   它自己会按退避重试；退避用完就安静停住，等用户点「重新定位」。
      if (!silent) setLocationError(message);
      if (placeholder.current) setLocationStatus('fallback');
      if (!manualPick.current) {
        const attempt = locationAttempts.current;
        if (attempt >= LOCATION_RETRY_MS.length) {
          locationBackoff.current = true;
        } else {
          locationAttempts.current = attempt + 1;
          locationBackoff.current = true;
          const delay = LOCATION_RETRY_MS[attempt];
          locationRetry.current = setTimeout(() => {
            locationBackoff.current = false;
            locate({ silent: true });
          }, delay);
        }
      }
      return { ok: false, reason: 'error', message };
    }
  }, [setCity]);

  const refresh = useCallback(async () => {
    const requestedCity = activeCity.current;
    const key = weatherCacheKey(requestedCity);
    const version = selectionVersion.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () => !controller.signal.aborted && request.current === controller && selectionVersion.current === version;
    setSnapshot((previous) => ({ key, data: previous.key === key ? previous.data : readCachedWeather(requestedCity), status: 'loading' }));
    try {
      const result = await fetchWeather(requestedCity, { signal: controller.signal });
      if (!isCurrent()) return;
      const data = normalizeWeather(result, requestedCity);
      if (!data) throw new Error('Weather observation is invalid or too old');
      setNow(new Date());
      setSnapshot({ key, data, status: isWeatherFresh(data) ? 'live' : 'cached' });
      writeStore(key, data);
      // ★ 天气拉通了 ⇒ 网络已经回来。顺手把定位的退避解锁，让下一次时效检查
      //   （15 分钟一次 / 窗口重新聚焦）能自己重试 —— 否则"网络恢复了但定位还在罚站"。
      locationAttempts.current = 0;
      locationBackoff.current = false;
    } catch {
      if (!isCurrent()) return;
      setNow(new Date());
      setSnapshot((previous) => {
        // Keep a valid in-memory observation even if localStorage was full.
        const data = (previous.key === key ? normalizeWeather(previous.data, requestedCity) : null)
          ?? readCachedWeather(requestedCity);
        return { key, data, status: data ? 'cached' : 'offline' };
      });
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15 * 60 * 1000);
    return () => { clearInterval(timer); request.current?.abort(); };
  }, [city, refresh]);

  useEffect(() => {
    // A saved choice always wins. Failed automatic lookup leaves an explicitly
    // labelled fallback and does not persist Wuhan as though the user chose it.
    if (!savedCity) locate({ silent: false });
    // 存档里的网络定位结果过期了（含"旧版本存档没有时间戳"）→ 悄悄换一次新的。
    else if (savedCity.source === 'approximate' && isLocationStale(savedCity)) locate({ silent: true });
    return () => { clearTimeout(locationRetry.current); locationRequest.current?.abort(); };
  }, [savedCity, locate]);

  useEffect(() => {
    // 时效检查：每 15 分钟看一眼，另外在窗口重新聚焦 / 重新可见时也看一次 ——
    // 笔记本合盖、换到另一个网络再打开，就是靠这一下自己纠正过来的。
    const check = () => {
      if (document.visibilityState === 'hidden') return;
      if (manualPick.current || activeCity.current.source !== 'approximate') return;
      if (isLocationStale(activeCity.current)) locate({ silent: true });
    };
    const timer = setInterval(check, LOCATION_CHECK_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [locate]);

  useEffect(() => {
    const updateClock = () => setNow(new Date());
    const timer = setInterval(updateClock, 30_000);
    window.addEventListener('focus', updateClock);
    document.addEventListener('visibilitychange', updateClock);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', updateClock);
      document.removeEventListener('visibilitychange', updateClock);
    };
  }, []);

  const matchesCity = snapshot.key === weatherCacheKey(city);
  const data = matchesCity ? normalizeWeather(snapshot.data, city, now) : null;
  const fresh = isWeatherFresh(data, now);
  const status = !matchesCity ? 'loading' : snapshot.status === 'loading' ? 'loading'
    : !data ? 'offline' : snapshot.status === 'live' && fresh ? 'live' : 'cached';
  const phase = getDayPhase(now);
  // Cached isDay describes the observation time, not the current clock.
  const night = settings.day === 'auto' ? (status === 'live' && fresh ? !data.isDay : phase === 'night') : settings.day === 'night';
  return {
    city, setCity, locate, locationStatus, locationBusy, locationError,
    data, status, refresh, now,
    season: settings.season === 'auto' ? getSeason(now, city.latitude) : settings.season,
    weather: settings.weather === 'auto' ? (data?.weather || 'sunny') : settings.weather,
    night, solarTerm: getSolarTerm(now),
  };
}
