/** No API key is required for Open-Meteo's public, non-commercial API.
 * https://open-meteo.com/en/docs
 * https://open-meteo.com/en/docs/geocoding-api
 */
export const DEFAULT_CITY = Object.freeze({
  id: 'wuhan', name: '武汉', latitude: 30.5928, longitude: 114.3055,
});

const REQUEST_TIMEOUT_MS = 10_000;
/** 单个定位源的超时。比天气短 —— 定位"快"比"准到最后一米"重要，慢的源要赶紧让位给下一个。*/
const LOCATION_TIMEOUT_MS = 5_000;
/** 整条降级链的总预算。四个源各 5s 串行 = 20s 太久，到点就收手走兜底。*/
const LOCATION_BUDGET_MS = 12_000;
const SEASONS = ['winter', 'spring', 'summer', 'autumn'];
const SOLAR_TERMS = [
  '春分', '清明', '谷雨', '立夏', '小满', '芒种',
  '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
  '秋分', '寒露', '霜降', '立冬', '小雪', '大雪',
  '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰',
];
const CITY_ALIASES = {
  武汉: 'Wuhan', 北京: 'Beijing', 上海: 'Shanghai', 广州: 'Guangzhou', 深圳: 'Shenzhen',
  杭州: 'Hangzhou', 苏州: 'Suzhou', 南京: 'Nanjing', 成都: 'Chengdu', 重庆: 'Chongqing',
  天津: 'Tianjin', 西安: "Xi'an", 长沙: 'Changsha', 郑州: 'Zhengzhou', 青岛: 'Qingdao',
  厦门: 'Xiamen', 福州: 'Fuzhou', 昆明: 'Kunming', 合肥: 'Hefei', 济南: 'Jinan',
  沈阳: 'Shenyang', 大连: 'Dalian', 哈尔滨: 'Harbin', 长春: 'Changchun', 石家庄: 'Shijiazhuang',
  太原: 'Taiyuan', 南昌: 'Nanchang', 南宁: 'Nanning', 贵阳: 'Guiyang', 海口: 'Haikou',
  三亚: 'Sanya', 兰州: 'Lanzhou', 银川: 'Yinchuan', 西宁: 'Xining', 拉萨: 'Lhasa',
  乌鲁木齐: 'Urumqi', 呼和浩特: 'Hohhot', 宁波: 'Ningbo', 无锡: 'Wuxi', 珠海: 'Zhuhai',
};
const WEATHER = new Map([
  [0, ['sunny', '晴']], [1, ['sunny', '晴间多云']], [2, ['cloudy', '多云']], [3, ['cloudy', '阴']],
  [45, ['foggy', '雾']], [48, ['foggy', '雾凇']],
  [51, ['rainy', '小毛毛雨']], [53, ['rainy', '毛毛雨']], [55, ['rainy', '浓毛毛雨']],
  [56, ['rainy', '轻冻毛毛雨']], [57, ['rainy', '冻毛毛雨']],
  [61, ['rainy', '小雨']], [63, ['rainy', '中雨']], [65, ['rainy', '大雨']],
  [66, ['rainy', '轻冻雨']], [67, ['rainy', '冻雨']],
  [71, ['snowy', '小雪']], [73, ['snowy', '中雪']], [75, ['snowy', '大雪']], [77, ['snowy', '米雪']],
  [80, ['rainy', '小阵雨']], [81, ['rainy', '阵雨']], [82, ['rainy', '强阵雨']],
  [85, ['snowy', '小阵雪']], [86, ['snowy', '强阵雪']],
  [95, ['stormy', '雷雨']], [96, ['stormy', '雷雨伴冰雹']], [97, ['stormy', '强雷雨']], [99, ['stormy', '强雷雨伴冰雹']],
]);

function requireDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RangeError('日期无效');
  }
  return date;
}

/** Local-calendar meteorological seasons; equatorial locations use the northern convention. */
export function getSeason(date = new Date(), latitude = 30) {
  requireDate(date);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new RangeError('纬度无效');
  const seasonIndex = Math.floor(((date.getMonth() + 1) % 12) / 3);
  return SEASONS[(seasonIndex + (latitude < 0 ? 2 : 0)) % 4];
}

/** Offline ambience uses the device clock. Live daylight should use fetchWeather().isDay. */
export function getDayPhase(date = new Date()) {
  const hour = requireDate(date).getHours();
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'dusk';
  return 'night';
}

/* ── 昼夜连续化（2026-10-04）────────────────────────────────────────
 * `getDayPhase()` 返回四个离散档，而下游有 15+ 处 `night ? A : B` 的硬切换：
 *   光场 ambient 在 .36/.28 之间**瞬跳**、夜罩 alpha 在 0/.22 之间跳、
 *   光池/光柱在`night` 一变就整层消失、蝴蝶与萤火虫互斥。
 *   ⇒ 一天之内画面只有 4 种状态，黎明黄昏这两个最容易看出"跳"的时刻反而最粗。
 *
 * `dayLightAt()` 给出一个 **0..1 的连续亮度标量**（0 = 深夜，1 = 白昼），
 * 下游把它插值到每一处幅度上。`getDayPhase()` 保留不变（它仍用于
 * 「要不要画萤火虫」这类**门控**判断 —— 门控就该是离散的）。
 *
 * ★ 为什么不用"真·天文曙暮光"（太阳高度角）而用四个权重点：
 *   · 太阳高度角要经度/纬度/日期，跨半球与极区会给出反直觉的答案（夏至极昼）；
 *   · 本作「摸鱼桌面」要的是**情绪曲线**而非天文正确性，
 *     而 5/7/17/19 这组时间点本来就是 `getDayPhase` 既有的分界
 *     ⇒ 与既有行为完全对齐，只是把阶跃换成过渡。
 *   真要天文口径，应当接 `fetchWeather().isDay` 做锚定（见 useEnvironment）。
 */

/** 亮度关键点（与 getDayPhase 的分界对齐）。值是 dayLight，**升序**。 */
const DAYLIGHT_KEYS = Object.freeze([
  { hour: 0, light: 0, phase: 'deep-night' },
  { hour: 5, light: 0, phase: 'night' },      // 黎明起点：仍是夜
  { hour: 7, light: 1, phase: 'day' },        // 白昼起点
  { hour: 17, light: 1, phase: 'day' },       // 白昼终点
  { hour: 19, light: 0, phase: 'night' },     // 入夜完成
  { hour: 24, light: 0, phase: 'deep-night' },
]);

/** 单调三次插值（smoothstep）—— 两端一阶导为 0 ⇒ 过渡段起止都不"打钩"。 */
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * 当前时刻的**连续**昼夜亮度，0（深夜）.. 1（白昼）。
 *
 * 曲线形状（实测，见 tools/check-daylight.cjs）：
 *   00:00–05:00  0.000 平台（深夜）
 *   05:00–07:00  0 → 1 平滑上升（黎明，两端导数为 0）
 *   07:00–17:00  1.000 平台（白昼）
 *   17:00–19:00  1 → 0 平滑下降（黄昏）
 *   19:00–24:00  0.000 平台（夜）
 *
 * ⚠️ **平台是有意为之**：真实白昼也不是全天一样亮，但本作只有一个"白昼"档，
 *   若让07:00–17:00 内部也起伏，白天就会有一道缓慢明暗波纹在池面上晃 ——
 *   那是另一个问题（且会让「水色随节气」的光场判据变脏）。先保持平坦。
 *
 * @param date 默认当前时间
 * @returns {number} 0..1
 */
export function dayLightAt(date = new Date()) {
  const hour = requireDate(date).getHours() + requireDate(date).getMinutes() / 60;
  const keys = DAYLIGHT_KEYS;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    // 边界用"半开"区间 + 末段兜底，避免 hour 恰在关键点上时 t 算出负值
    if (hour < b.hour || i === keys.length - 2) {
      const t = (hour - a.hour) / (b.hour - a.hour);
      return a.light + (b.light - a.light) * smoothstep(Math.max(0, Math.min(1, t)));
    }
  }
  return 0;
}

/**
 * Returns the current solar term, not a lunar festival or the next term.
 * Approximate apparent solar longitude, using the Meeus/NOAA equations:
 * https://gml.noaa.gov/grad/solcalc/calcdetails.html
 * Supported display range: 1900–2100. This is recreational calendar ambience;
 * transition instants are approximate, not an authoritative almanac. Uses the
 * UTC instant (not a fixed table of month/day boundaries or local midnight).
 */
export function solarLongitude(date = new Date()) {
  requireDate(date);
  if (date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 2100) return null;
  const centuries = (date.getTime() / 86_400_000 + 2440587.5 - 2451545) / 36525;
  const normalize = (angle) => ((angle % 360) + 360) % 360;
  const sin = (angle) => Math.sin(angle * Math.PI / 180);
  const meanLongitude = normalize(280.46646 + centuries * (36000.76983 + centuries * 0.0003032));
  const anomaly = 357.52911 + centuries * (35999.05029 - 0.0001537 * centuries);
  const center = sin(anomaly) * (1.914602 - centuries * (0.004817 + 0.000014 * centuries))
    + sin(2 * anomaly) * (0.019993 - 0.000101 * centuries) + sin(3 * anomaly) * 0.000289;
  return normalize(meanLongitude + center - 0.00569 - 0.00478 * sin(125.04 - 1934.136 * centuries));
}

/** Reuses solarLongitude so the almanac can interpolate between terms (F-24 渐变). */
export function getSolarTerm(date = new Date()) {
  const longitude = solarLongitude(date);
  return longitude === null ? '' : SOLAR_TERMS[Math.floor(longitude / 15)];
}

/** Unknown codes deliberately render a neutral cloudy scene, never fabricated sunshine. */
export function mapWeatherCode(code) {
  return WEATHER.get(code)?.[0] ?? 'cloudy';
}

function serviceError(name, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = name;
  return error;
}

function abortError() {
  return new DOMException('请求已取消', 'AbortError');
}

async function requestJson(url, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort(abortError());
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(serviceError('TimeoutError', '天气服务连接超时，请稍后重试')), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw serviceError('WeatherNetworkError', `天气服务暂时不可用（${response.status}）`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw serviceError('WeatherDataError', '天气服务返回的数据无法读取', error);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
      throw serviceError('WeatherDataError', '天气服务返回的数据不完整');
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error.name === 'WeatherNetworkError' || error.name === 'WeatherDataError') throw error;
    throw serviceError('WeatherNetworkError', '暂时无法连接天气服务，请检查网络后重试', error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function hasCoordinates(city) {
  return city && Number.isFinite(city.latitude) && Math.abs(city.latitude) <= 90
    && Number.isFinite(city.longitude) && Math.abs(city.longitude) <= 180;
}

/** Search all countries; common Chinese aliases improve GeoNames matching. */
export async function searchCities(query, { signal } = {}) {
  if (typeof query !== 'string') throw new TypeError('请输入城市名称');
  const input = query.trim();
  if (input.length < 2) return [];
  if (input.length > 80) throw new RangeError('城市名称过长');
  const aliasKey = input.replace(/市$/, '');
  const alias = Object.hasOwn(CITY_ALIASES, aliasKey) ? CITY_ALIASES[aliasKey] : undefined;
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name: alias ?? input, count: '8', language: 'zh', format: 'json' }).toString();
  if (alias) url.searchParams.set('countryCode', 'CN');
  const data = await requestJson(url, signal);
  if (data.results === undefined) return [];
  if (!Array.isArray(data.results)) throw serviceError('WeatherDataError', '城市搜索返回的数据不完整');
  const seen = new Set();
  return data.results.filter((city) => {
    if (!hasCoordinates(city) || typeof city.name !== 'string' || !city.name.trim()) return false;
    const key = `${city.latitude},${city.longitude}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((city) => ({
    id: city.id ?? `${city.latitude},${city.longitude}`,
    name: city.name,
    country: typeof city.country === 'string' ? city.country : '',
    latitude: city.latitude,
    longitude: city.longitude,
  }));
}

/**
 * Current conditions are Open-Meteo model data. Failure is thrown so the UI can
 * retain cached data or explicitly label its offline scene. No sample weather
 * is ever passed off as a successful live response.
 */
export async function fetchWeather(city, { signal } = {}) {
  if (!hasCoordinates(city)) throw new RangeError('城市坐标无效');
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(city.latitude), longitude: String(city.longitude),
    current: 'temperature_2m,weather_code,is_day', temperature_unit: 'celsius',
    timeformat: 'unixtime', timezone: 'auto', forecast_days: '1',
  }).toString();
  const { current } = await requestJson(url, signal);
  if (!current || !Number.isFinite(current.temperature_2m) || !Number.isInteger(current.weather_code)
    || (current.is_day !== 0 && current.is_day !== 1) || !Number.isFinite(current.time)
    || !Number.isFinite(new Date(current.time * 1000).getTime())) {
    throw serviceError('WeatherDataError', '当前天气数据不完整，请稍后重试');
  }
  return {
    temperature: current.temperature_2m,
    weather: mapWeatherCode(current.weather_code),
    description: WEATHER.get(current.weather_code)?.[1] ?? '天气暂不详',
    isDay: current.is_day === 1,
    updatedAt: new Date(current.time * 1000).toISOString(),
    city: { ...city },
  };
}

/**
 * 英文城市名 → 中文。
 *
 * ★ 为什么需要这张反查表：四个源里只有 `bigdatacloud` 与 `ipwho.is` 支持中文地名，
 *   降级到 `ipwhois.app` / `geolocation-db` 时返回的是 `"Beijing"` 这种英文名 ——
 *   面板上本来写着「武汉」，网络一变突然显示「Beijing」，读起来像坏了。
 *   覆盖 `CITY_ALIASES` 里的 40 个省会/主要城市；**表外的城市保持原样，不猜**
 *   （宁可显示 `Taizhou` 也不要瞎映射成别的城市）。
 */
const CITY_NAME_ZH = new Map(Object.entries(CITY_ALIASES).map(([zh, en]) => [en.trim().toLowerCase(), zh]));

function localizeCityName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return '';
  // 有些源会带后缀（"Beijing City" / "北京市"）—— 统一剥掉再查表，查不到就原样返回。
  const bare = name.replace(/\s*City$/i, '').replace(/市$/, '');
  return CITY_NAME_ZH.get(bare.toLowerCase()) ?? name;
}

/** 把一次 provider 响应整理成统一结构；任何一个关键字段不对就返回 null（不编造城市）。*/
function normalizeLocatedCity({ name, country, latitude, longitude }) {
  const city = {
    id: `approximate-${latitude},${longitude}`,
    name: localizeCityName(name).slice(0, 80),
    country: typeof country === 'string' ? country.trim().slice(0, 80) : '',
    latitude,
    longitude,
    source: 'approximate',
  };
  return hasCoordinates(city) && city.name ? city : null;
}

/**
 * IP 定位的**降级链**。按顺序试，第一个返回合法城市的结果就赢；全挂才抛错。
 *
 * ★ 为什么不能只有一个源（改造前就是）：`ipwho.is` 一旦被墙/被限流/改契约，
 *   用户就永久停在「武汉」兜底，而且**界面里没有任何重试入口**。
 *
 * ★ 为什么 bigdatacloud 排第一 —— 这是实测选的，不是随手排的：
 *   本机出口 IP `112.20.10.15`（中国移动 AS56046）在各家库里的归属：
 *     ipinfo → Shanghai · ipwho.is / ipwhois.app / geolocation-db / ip2location → Beijing
 *     bigdatacloud → **泰州市 / 高港区**
 *   它和本机实际所在地一致，而且是唯一能给到「区」这一级的源 ⇒ 库最细。
 *   它还支持 `localityLanguage=zh`，返回来就是中文地名，不用靠反查表。
 *   ⚠️ 这个结论来自**单个网络观测点**。换一家运营商/换城市后如果发现它反而更粗，
 *      把 `ipwho.is` 挪到第一位即可 —— 链的顺序是纯数据，没有别处依赖它。
 *
 * ★ 为什么是串行而不是并行：并行要等最慢的那个，而这里**优先级本身就是答案的一部分**
 *   （更细的源更该赢）。串行 + 短超时（见 LOCATION_TIMEOUT_MS / LOCATION_BUDGET_MS）
 *   能做到「首选可用就只花一次往返」。
 */
/**
 * 降级链本身，**导出给探针工具与单测**（`tools/probe-location.js` 要能逐源单独打，
 * 单测要能断言顺序）。UI 不读它 —— 顺序只在 `lookupApproximateCity` 里生效。
 * 只读使用：`request()` 返回 URL、`parse(data)` 返回城市或 null，都没有副作用。
 */
export const LOCATION_PROVIDERS = [
  {
    id: 'bigdatacloud',
    label: 'BigDataCloud',
    request: () => {
      const url = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client');
      url.search = new URLSearchParams({ localityLanguage: 'zh' }).toString();
      return url;
    },
    // 这个端点本来是做「经纬度 → 地名」的反查，不带参数时按 IP 定位（响应里 lookupSource 会写 ip geolocation）。
    // 名字取 city → locality → principalSubdivision 逐级退让：乡镇级 IP 常常没有 city，只有 district。
    parse: (data) => normalizeLocatedCity({
      name: data.city || data.locality || data.principalSubdivision,
      country: data.countryName,
      latitude: data.latitude,
      longitude: data.longitude,
    }),
  },
  {
    id: 'ipwho.is',
    label: 'ipwho.is',
    // 只取需要的那几个字段：**响应里的 IP 地址与网络元数据根本不下发**，
    // 于是也没有"顺手存下来"的机会。
    request: () => {
      const url = new URL('https://ipwho.is/');
      url.search = new URLSearchParams({ fields: 'success,city,country,latitude,longitude', lang: 'zh-CN' }).toString();
      return url;
    },
    parse: (data) => (data.success === true ? normalizeLocatedCity({
      name: data.city, country: data.country, latitude: data.latitude, longitude: data.longitude,
    }) : null),
  },
  {
    id: 'ipwhois.app',
    label: 'ipwhois.app',
    request: () => new URL('https://ipwhois.app/json/'),
    parse: (data) => (data.success === true ? normalizeLocatedCity({
      name: data.city, country: data.country, latitude: data.latitude, longitude: data.longitude,
    }) : null),
  },
  {
    id: 'geolocation-db',
    label: 'Geolocation DB',
    request: () => new URL('https://geolocation-db.com/json/'),
    // 这个源失败时不报错，而是返回一堆 null —— 靠 normalizeLocatedCity 的坐标校验兜住。
    parse: (data) => normalizeLocatedCity({
      name: data.city, country: data.country_name, latitude: data.latitude, longitude: data.longitude,
    }),
  },
];

/** 只列 id，给"顺序有没有被改乱"这类断言用。*/
export const LOCATION_PROVIDER_IDS = Object.freeze(LOCATION_PROVIDERS.map((provider) => provider.id));

/**
 * 按 IP 大致定位到城市。只在**没有保存过城市**时自动调用，或用户点「重新定位」时显式调用。
 *
 * 契约（改造前后一致，UI 与存档都依赖）：
 *   - 成功返回 `{id, name, country, latitude, longitude, source: 'approximate'}`
 *   - 失败抛 `LocationDataError`；`error.cause` 挂着**最后一个**源的真实原因（排查用，不展示给用户）
 *   - **任何 provider 返回的 IP / ASN / 时区等字段都不会被带出来**
 *
 * @param {{signal?: AbortSignal}} [options]
 */
export async function lookupApproximateCity({ signal } = {}) {
  const deadline = Date.now() + LOCATION_BUDGET_MS;
  let lastError;

  for (const provider of LOCATION_PROVIDERS) {
    if (signal?.aborted) throw abortError();
    if (Date.now() >= deadline) break;
    const remaining = Math.min(LOCATION_TIMEOUT_MS, deadline - Date.now());
    try {
      const data = await requestJson(provider.request(), signal, remaining);
      const city = provider.parse(data);
      if (city) return city;
      lastError = serviceError('LocationDataError', `${provider.label} 返回的位置信息不完整`);
    } catch (error) {
      // ★ 用户主动取消（关面板/切城市）**不是**换下一个源的理由 —— 必须停，否则
      //   面板已经关了还在后台把四个源跑一遍。
      if (signal?.aborted) throw abortError();
      lastError = error;
    }
  }

  // ★ 失败文案要能区分两件事 ——「网络不通」和「四个源都活着但答非所问」对用户是两种处置：
  //   前者该说"检查网络"，后者该说"手动选城市"。混成一句话就两种都不准。
  //   `error.cause.name` 是排查用的，不展示给用户。
  const offline = lastError instanceof Error && /NetworkError|TimeoutError/.test(lastError.name);
  throw serviceError('LocationDataError', offline
    ? '连不上定位服务，可手动搜索城市。'
    : '暂时无法识别所在城市，可手动搜索城市。', lastError);
}
