import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CITY, getSeason, getDayPhase, dayLightAt, getSolarTerm, mapWeatherCode, searchCities, fetchWeather } from '../src/lib/environment.js';
import * as environment from '../src/lib/environment.js';

test('meteorological seasons change at local month boundaries and invert south of the equator', () => {
  assert.equal(getSeason(new Date(2026, 1, 28, 23, 59)), 'winter');
  assert.equal(getSeason(new Date(2026, 2, 1)), 'spring');
  assert.equal(getSeason(new Date(2026, 5, 1)), 'summer');
  assert.equal(getSeason(new Date(2026, 8, 1)), 'autumn');
  assert.equal(getSeason(new Date(2026, 11, 1)), 'winter');
  assert.equal(getSeason(new Date(2026, 11, 1), -33.87), 'summer');
  assert.equal(getSeason(new Date(2026, 2, 1), -33.87), 'autumn');
  assert.equal(getSeason(new Date(2026, 8, 1), 0), 'autumn');
});

test('day phase boundaries use local time for the offline scene', () => {
  for (const [hour, expected] of [[4, 'night'], [5, 'dawn'], [6, 'dawn'], [7, 'day'], [16, 'day'], [17, 'dusk'], [18, 'dusk'], [19, 'night'], [23, 'night']]) {
    assert.equal(getDayPhase(new Date(2026, 8, 27, hour)), expected);
  }
});

/* ══════════════════════════════════════════════════════════════════
 * 昼夜连续化（2026-10-04）
 * `dayLightAt()` 是 `getDayPhase()` 的连续版：0（深夜）.. 1（白昼）。
 * 存在的理由是下游有 15+ 处 `night ? A : B` 硬切换 ⇒ 一天只有4 种画面。
 * ══════════════════════════════════════════════════════════════════ */
const dl = (h, m = 0) => dayLightAt(new Date(2026, 8, 27, h, m));

test('★ dayLight 四个平台与关键点取值正确（与 getDayPhase 分界对齐）', () => {
  // 平台
  for (const h of [0, 1, 2, 3, 4]) assert.equal(dl(h), 0, `${h}:00 应为深夜 0`);
  for (const h of [7, 10, 12, 15, 16, 17]) assert.equal(dl(h), 1, `${h}:00 应为白昼 1`);
  for (const h of [19, 20, 22, 23]) assert.equal(dl(h), 0, `${h}:00 应为夜 0`);
  // 关键点（0/1 平台端点与过渡中点）
  assert.equal(dl(5), 0,'05:00 黎明起点应为 0');
  assert.equal(dl(6), 0.5, '06:00 过渡中点应为 0.5');
  assert.equal(dl(7), 1, '07:00 白昼起点应为 1');
  assert.equal(dl(18), 0.5, '18:00 过渡中点应为 0.5');
  assert.equal(dl(19), 0, '19:00 入夜完成应为 0');
});

test('★ dayLight 单调可逆：黎明严格升、黄昏严格降，且无跳变（相邻分钟差 < 0.02）', () => {
  // 黎明 5:00 → 7:00 逐分钟必须单调升
  for (let m = 1; m <= 120; m++) {
    const a = dl(5, m - 1), b = dl(5, m);
    assert.ok(b >= a - 1e-9, `黎明 ${m} 分钟处回落：${a} -> ${b}`);
    assert.ok(b - a < 0.02, `黎明 ${m} 分钟处跳变过大：Δ=${(b - a).toFixed(4)}`);
  }
  // 黄昏 17:00 → 19:00 逐分钟必须单调降
  for (let m = 1; m <= 120; m++) {
    const a = dl(17, m - 1), b = dl(17, m);
    assert.ok(b <= a + 1e-9, `黄昏 ${m} 分钟处回升：${a} -> ${b}`);
    assert.ok(a - b < 0.02, `黄昏 ${m} 分钟处跳变过大：Δ=${(a - b).toFixed(4)}`);
  }
  // 平台段必须**逐位不变**（不能有缓慢漂移）
  for (let h = 8; h < 16; h++) {
    assert.equal(dl(h), 1, `${h}:00 白昼平台必须恒为 1`);
    assert.equal(dl(h, 30), 1, `${h}:30 白昼平台必须恒为 1`);
  }
});

test('★ dayLight 覆盖全天 1440 分钟、值域严格 [0,1]、无NaN', () => {
  let min = 1, max = 0;
  for (let m = 0; m < 1440; m++) {
    const v = dl(Math.floor(m / 60), m % 60);
    assert.ok(Number.isFinite(v), `${Math.floor(m / 60)}:${m % 60} 是 ${v}`);
    min = Math.min(min, v); max = Math.max(max, v);
  }
  assert.equal(min, 0, `全天最小值应为 0，实为 ${min}`);
  assert.equal(max, 1, `全天最大值应为 1，实为 ${max}`);
});

test('dayLight 拒绝非法日期（与 getDayPhase 同一把尺子）', () => {
  assert.throws(() => dayLightAt(new Date('invalid')), RangeError);
});

test('★ 阳性对照：把 getDayPhase 的边界挪动，dayLight 平台必须跟着动', () => {
  // 若 dayLight 与 getDayPhase 脱钩（例如各写一套时间点），
  // 就会出现「getDayPhase 说 night 但 dayLight=1」的矛盾画面。钉住两者的对应关系。
  for (let h = 0; h < 24; h++) {
    const phase = getDayPhase(new Date(2026, 8, 27, h));
    const v = dl(h);
    if (phase === 'day') assert.equal(v, 1, `${h}:00 getDayPhase=day 但 dayLight=${v}`);
    if (phase === 'night') assert.equal(v, 0, `${h}:00 getDayPhase=night 但 dayLight=${v}`);
    // dawn / dusk 允许 0<v<1（这正是连续化要覆盖的窗口）
  }
});

test('invalid calendar inputs and latitude never silently select a season', () => {
  assert.throws(() => getSeason(new Date('invalid')), RangeError);
  assert.throws(() => getSeason(new Date(), 91), RangeError);
  assert.throws(() => getDayPhase(new Date('invalid')), RangeError);
  assert.throws(() => getSolarTerm(new Date('invalid')), RangeError);
});

test('solar terms wrap across New Year and spring equinox without lunar-festival substitutions', () => {
  const cases = [
    ['2026-01-01T12:00:00Z', '冬至'],
    ['2026-01-07T12:00:00Z', '小寒'],
    ['2026-02-06T12:00:00Z', '立春'],
    ['2026-03-19T12:00:00Z', '惊蛰'],
    ['2026-03-21T12:00:00Z', '春分'],
    ['2026-06-22T12:00:00Z', '夏至'],
    ['2026-09-27T12:00:00Z', '秋分'],
    ['2026-12-23T12:00:00Z', '冬至'],
  ];
  for (const [date, expected] of cases) assert.equal(getSolarTerm(new Date(date)), expected);
  assert.equal(getSolarTerm(new Date('1800-01-01T00:00:00Z')), '');
  assert.equal(getSolarTerm(new Date('2101-01-01T00:00:00Z')), '');
});

test('weather mapping distinguishes fog, freezing rain, snowfall, and thunderstorms', () => {
  for (const [codes, weather] of [
    [[0, 1], 'sunny'], [[2, 3], 'cloudy'], [[45, 48], 'foggy'],
    [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], 'rainy'],
    [[95, 96, 97, 99], 'stormy'], [[71, 73, 75, 77, 85, 86], 'snowy'], [[null, undefined, -1, 999, '0'], 'cloudy'],
  ]) for (const code of codes) assert.equal(mapWeatherCode(code), weather);
});

test('city search accepts Chinese aliases, uses the real geocoding contract, and drops malformed coordinates', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://geocoding-api.open-meteo.com');
    assert.equal(request.searchParams.get('name'), 'Wuhan');
    assert.equal(request.searchParams.get('countryCode'), 'CN');
    assert.equal(request.searchParams.get('language'), 'zh');
    return new Response(JSON.stringify({ results: [
      { id: 1791247, name: '武汉', country: '中国', latitude: 30.58333, longitude: 114.26667, timezone: 'Asia/Shanghai' },
      { id: 1, name: '坏坐标', country: '中国', latitude: null, longitude: 114 },
      { id: 2, name: '越界', country: '中国', latitude: 95, longitude: 114 },
    ], generationtime_ms: 0.4 }));
  });
  const results = await searchCities(' 武汉市 ');
  assert.deepEqual(results, [{ id: 1791247, name: '武汉', country: '中国', latitude: 30.58333, longitude: 114.26667 }]);
});

test('short and empty city searches do not make unnecessary network requests', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No request expected'));
  assert.deepEqual(await searchCities(' '), []);
  assert.deepEqual(await searchCities('a'), []);
  await assert.rejects(searchCities('x'.repeat(81)), RangeError);
});

test('city search safely encodes arbitrary foreign names and accepts an empty result', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.searchParams.get('name'), 'Paris, France');
    assert.equal(request.searchParams.has('countryCode'), false);
    return new Response('{}');
  });
  assert.deepEqual(await searchCities('Paris, France'), []);
});

test('ordinary object-property names are not mistaken for Chinese city aliases', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.searchParams.get('name'), 'constructor');
    assert.equal(request.searchParams.has('countryCode'), false);
    return new Response('{}');
  });
  assert.deepEqual(await searchCities('constructor'), []);
});

const currentFixture = {
  latitude: 30.625, longitude: 114.25, generationtime_ms: 0.03,
  utc_offset_seconds: 28800, timezone: 'Asia/Shanghai', timezone_abbreviation: 'GMT+8', elevation: 34,
  current_units: { time: 'unixtime', interval: 'seconds', temperature_2m: '°C', weather_code: 'wmo code', is_day: '' },
  current: { time: 1790467200, interval: 900, temperature_2m: 23.6, weather_code: 63, is_day: 0 },
};

test('weather preserves UTC observation time independently of destination timezone', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://api.open-meteo.com');
    assert.equal(request.searchParams.get('timeformat'), 'unixtime');
    assert.equal(request.searchParams.get('current'), 'temperature_2m,weather_code,is_day');
    assert.equal(request.searchParams.get('latitude'), '30.5928');
    return new Response(JSON.stringify(currentFixture));
  });
  const weather = await fetchWeather(DEFAULT_CITY);
  assert.equal(weather.temperature, 23.6);
  assert.equal(weather.weather, 'rainy');
  assert.equal(weather.description, '中雨');
  assert.equal(weather.isDay, false);
  assert.equal(weather.updatedAt, '2026-09-27T00:00:00.000Z');
  assert.deepEqual(weather.city, DEFAULT_CITY);
});

test('unknown valid weather codes are displayed honestly with a neutral scene', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...currentFixture, current: { ...currentFixture.current, weather_code: 999, is_day: 1 } })));
  const weather = await fetchWeather(DEFAULT_CITY);
  assert.equal(weather.weather, 'cloudy');
  assert.equal(weather.description, '天气暂不详');
  assert.equal(weather.isDay, true);
});

test('weather refuses invalid input coordinates before sending a request', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No request expected'));
  for (const city of [null, { latitude: null, longitude: 0 }, { latitude: 0, longitude: 181 }]) {
    await assert.rejects(fetchWeather(city), RangeError);
  }
});

test('missing current data cannot be mislabeled as zero degrees and a clear sky', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ...currentFixture, current: { ...currentFixture.current, temperature_2m: null } })));
  await assert.rejects(fetchWeather(DEFAULT_CITY), { name: 'WeatherDataError' });
});

test('HTTP failures are surfaced for the UI fallback instead of fabricating live weather', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(fetchWeather(DEFAULT_CITY), { name: 'WeatherNetworkError' });
});

test('malformed JSON is surfaced as a data error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad gateway</html>'));
  await assert.rejects(searchCities('杭州'), { name: 'WeatherDataError' });
});

test('pre-aborted requests do not access the network', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No request expected'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchWeather(DEFAULT_CITY, { signal: controller.signal }), { name: 'AbortError' });
});

test('cancelling an in-flight search aborts its fetch and preserves AbortError', async (t) => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const promise = searchCities('武汉', { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});

test('slow weather requests time out so refresh cannot remain stuck', { timeout: 1000 }, async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback) => realSetTimeout(callback, 5));
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(fetchWeather(DEFAULT_CITY), { name: 'TimeoutError' });
});

test('every location provider is allowed by the page CSP, so the fallback chain cannot go silently dead', async () => {
  // ★ 这条断言来自一次真机事故：CSP 的 connect-src 白名单当时只写了 https://ipwho.is，
  //   于是新加的另外三个源在浏览器里**连请求都发不出去**（CSP 在 DNS 之前就拦掉），
  //   整条降级链在桌面版里是空转的 —— 而 `vite build` 和所有单测都是绿的。
  //   把「provider 列表」与「CSP 白名单」绑在一起，这类沉默失效就只能变成红灯。
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy, 'index.html 必须带 Content-Security-Policy');
  const directive = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src'));
  assert.ok(directive, 'CSP 必须有 connect-src，否则网络请求无从约束');
  const allowed = new Set(directive.split(/\s+/).slice(1));
  for (const provider of environment.LOCATION_PROVIDERS) {
    const origin = provider.request().origin;
    assert.ok(allowed.has(origin), `${provider.id} 的 ${origin} 不在 connect-src 白名单里，该源在真机上永远不会被请求`);
  }
});

test('the location chain starts with the measured-best provider and asks for nothing else', async (t) => {
  assert.equal(typeof environment.lookupApproximateCity, 'function');
  // 顺序本身就是结论的一部分（见 environment.js 的实测记录）—— 改顺序要连这里的断言一起改。
  assert.deepEqual(environment.LOCATION_PROVIDER_IDS, ['bigdatacloud', 'ipwho.is', 'ipwhois.app', 'geolocation-db']);
  const hits = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    hits.push(request.origin);
    assert.equal(request.origin, 'https://api.bigdatacloud.net');
    assert.deepEqual([...request.searchParams.keys()], ['localityLanguage']);
    return new Response(JSON.stringify({
      city: '泰州市', locality: '高港区', principalSubdivision: '江苏省', countryName: '中华人民共和国',
      latitude: 32.44, longitude: 119.92, ip: '192.0.2.1',
    }));
  });
  const city = await environment.lookupApproximateCity();
  // ★ 首选可用就只花一次往返 —— 串行降级链的意义在这里，不是把四个源都打一遍。
  assert.deepEqual(hits, ['https://api.bigdatacloud.net']);
  assert.equal(city.name, '泰州市');
  assert.equal(city.country, '中华人民共和国');
  assert.equal(city.source, 'approximate');
  assert.equal(city.latitude, 32.44);
  assert.equal(Object.hasOwn(city, 'ip'), false);
});

test('a provider that fails, or answers without a usable city, falls through to the next one', async (t) => {
  const hits = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const origin = new URL(url).origin;
    hits.push(origin);
    if (origin === 'https://api.bigdatacloud.net') throw new TypeError('fetch failed');
    // 第二个源活着、也有坐标，但没给城市名 —— 不能"反正有坐标就用"，必须继续往下走。
    if (origin === 'https://ipwho.is') return new Response(JSON.stringify({ city: null, latitude: 30.1, longitude: 120.2 }));
    assert.equal(origin, 'https://ipwhois.app');
    return new Response(JSON.stringify({ success: true, city: 'Beijing', country: 'China', latitude: 39.9, longitude: 116.4 }));
  });
  const city = await environment.lookupApproximateCity();
  assert.deepEqual(hits, ['https://api.bigdatacloud.net', 'https://ipwho.is', 'https://ipwhois.app']);
  // ★ 英文城市名要换回中文 —— 否则面板上本来写着「武汉」，网络一变突然冒出个 "Beijing"，像坏了。
  assert.equal(city.name, '北京');
});

test('a city the alias table does not know is passed through instead of guessed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    city: 'Taizhou', country: 'China', latitude: 32.44, longitude: 119.92,
  })));
  assert.equal((await environment.lookupApproximateCity()).name, 'Taizhou');
});

test('every provider failing raises LocationDataError, and only after the whole chain was tried', async (t) => {
  const hits = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    hits.push(new URL(url).origin);
    return new Response(JSON.stringify({ success: false }));
  });
  await assert.rejects(environment.lookupApproximateCity(), { name: 'LocationDataError' });
  assert.equal(hits.length, environment.LOCATION_PROVIDER_IDS.length);
});

test('cancelling a lookup stops the chain instead of trying the remaining providers', async (t) => {
  const controller = new AbortController();
  const hits = [];
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((_resolve, reject) => {
    hits.push(new URL(url).origin);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const promise = environment.lookupApproximateCity({ signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  // ★ 用户取消不是"换下一个源"的理由 —— 否则面板已经关了，后台还在把四个源跑一遍。
  assert.deepEqual(hits, ['https://api.bigdatacloud.net']);
});

test('failed or invalid approximate locations are rejected instead of appearing as valid cities', async (t) => {
  assert.equal(typeof environment.lookupApproximateCity, 'function');
  const payloads = [{ success: false }, { success: true, city: 'Bad city', latitude: null, longitude: 114 }, { success: true, city: {}, latitude: 30, longitude: 114 }];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payloads.shift())));
  for (let i = 0; i < 3; i++) await assert.rejects(environment.lookupApproximateCity(), { name: 'LocationDataError' });
});
