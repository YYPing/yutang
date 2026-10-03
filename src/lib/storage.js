export function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const DEFAULT_SETTINGS = Object.freeze({
  season: 'auto', weather: 'auto', day: 'auto', almanacMode: 'follow', almanacTerm: '',
  fishCount: 12, fishSize: 1, turtleCount: 0, quality: 'high',
  reducedMotion: false, sound: false, volume: 0.18, ecoMode: false, ecoSpeed: 1, collision: true,
});
// §3 演化倍速档位。与 engine/simulation.js 的 ECO_SPEEDS 必须一致 ——
// 这里再写一遍是为了让「存档是不可信输入」的校验不依赖引擎（storage 只该管持久化）。
const ECO_SPEEDS = [0.5, 1, 2, 5, 20];
const WEATHER_TYPES = ['sunny', 'cloudy', 'rainy', 'snowy', 'foggy', 'stormy'];
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const FRESH_WEATHER_MS = 30 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const clampNumber = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Persisted values are untrusted: scene keys feed object lookups and volume feeds Web Audio. */
export function loadSettings() {
  const stored = readStore('fusheng-settings', {});
  const source = isRecord(stored) ? stored : {};
  const pick = (key, values) => values.includes(source[key]) ? source[key] : DEFAULT_SETTINGS[key];
  return {
    season: pick('season', ['auto', 'spring', 'summer', 'autumn', 'winter']),
    weather: source.weather === 'foggy' ? 'stormy' : pick('weather', ['auto', ...WEATHER_TYPES]),
    day: pick('day', ['auto', 'day', 'night']),
    // 时令模式（F-24）。default `follow` = 跟随真实节气；`manual`/`cycle` 是用户主动选的预览态，
    // **必须持久化** —— 否则重启后跳回真实节气，用户会以为设置丢了。
    almanacMode: pick('almanacMode', ['follow', 'manual', 'cycle']),
    almanacTerm: typeof source.almanacTerm === 'string' && source.almanacTerm.length <= 4
      ? source.almanacTerm : DEFAULT_SETTINGS.almanacTerm,
    fishCount: Math.round(clampNumber(source.fishCount, 3, 24, DEFAULT_SETTINGS.fishCount)),
    fishSize: clampNumber(source.fishSize, .6, 1.6, 1),
    turtleCount: Math.round(clampNumber(source.turtleCount, 0, 4, 0)),
    quality: pick('quality', ['high', 'low']),
    reducedMotion: typeof source.reducedMotion === 'boolean' ? source.reducedMotion : false,
    sound: typeof source.sound === 'boolean' ? source.sound : false,
    volume: clampNumber(source.volume, 0, 0.6, DEFAULT_SETTINGS.volume),
    // 生态模式默认关：老用户升级后看到的仍是原来的池塘，要主动打开才接管生死。
    ecoMode: typeof source.ecoMode === 'boolean' ? source.ecoMode : false,
    ecoSpeed: ECO_SPEEDS.includes(source.ecoSpeed) ? source.ecoSpeed : 1,
    // 碰撞体积默认**开**。老存档没这个键 ⇒ 取 true（升级后自动获得新行为，
    // 且这是"鱼不该互相穿透"的基础正确性，不该要求用户手动打开）。
    collision: typeof source.collision === 'boolean' ? source.collision : true,
  };
}

export function loadFish() {
  const stored = readStore('fusheng-fish', []);
  if (!Array.isArray(stored)) return [];
  const seen = new Set();
  return stored.filter((fish) => {
    if (!isRecord(fish) || typeof fish.id !== 'string' || !fish.id.trim() || fish.id.length > 120
      || typeof fish.texture !== 'string' || fish.texture.length > 1_500_000
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(fish.texture) || seen.has(fish.id)) return false;
    seen.add(fish.id);
    return true;
  }).slice(0, 12).map((fish) => ({
    id: fish.id,
    name: typeof fish.name === 'string' && fish.name.trim() ? fish.name.trim().slice(0, 12) : '无名锦鲤',
    texture: fish.texture,
    size: clampNumber(fish.size, .55, 1.8, 1),
    appearance: fish.appearance === 'skin-v2' ? 'skin-v2' : 'legacy',
  }));
}

export function normalizeCity(value) {
  if (!isRecord(value) || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90
    || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180
    || typeof value.name !== 'string' || !value.name.trim()) return null;
  const city = {
    id: typeof value.id === 'string' || Number.isFinite(value.id) ? value.id : `${value.latitude},${value.longitude}`,
    name: value.name.trim().slice(0, 80), latitude: value.latitude, longitude: value.longitude,
  };
  if (typeof value.country === 'string') city.country = value.country.slice(0, 80);
  if (value.source === 'manual' || value.source === 'approximate') city.source = value.source;
  // `locatedAt` 只对「按网络定位」有意义：它是判断"这个结果该不该刷新"的唯一依据（见 useEnvironment
  // 的 LOCATION_TTL_MS）。手动选的城市不写 —— 它永远不会被自动刷新覆盖，写了反而误导。
  // ★ 只做结构校验（有限正数），不做时效校验：判"是否过期"是使用方的策略，storage 只管能不能信。
  if (city.source === 'approximate' && Number.isFinite(value.locatedAt) && value.locatedAt > 0) {
    city.locatedAt = value.locatedAt;
  }
  return city;
}

export function weatherCacheKey(city) {
  return `fusheng-weather-${city.latitude},${city.longitude}`;
}

function observationAge(weather, now) {
  if (typeof weather?.updatedAt !== 'string') return NaN;
  return Number(now) - Date.parse(weather.updatedAt);
}

/** A cache can describe previous conditions for 24h, but is never itself a live response. */
export function normalizeWeather(value, city, now = Date.now()) {
  const cachedCity = normalizeCity(value?.city);
  const age = observationAge(value, now);
  if (!isRecord(value) || !cachedCity || !city || cachedCity.latitude !== city.latitude || cachedCity.longitude !== city.longitude
    || !Number.isFinite(value.temperature) || value.temperature < -100 || value.temperature > 70
    || !WEATHER_TYPES.includes(value.weather) || typeof value.isDay !== 'boolean'
    || typeof value.description !== 'string' || !value.description.trim()
    || !Number.isFinite(age) || age < -CLOCK_TOLERANCE_MS || age > MAX_CACHE_AGE_MS) return null;
  return {
    temperature: value.temperature, weather: value.weather,
    description: value.description.trim().slice(0, 80), isDay: value.isDay,
    updatedAt: new Date(value.updatedAt).toISOString(), city: { ...city },
  };
}

export function readCachedWeather(city, now = Date.now()) {
  return normalizeWeather(readStore(weatherCacheKey(city), null), city, now);
}

/** Used in addition to response status so a sleeping window cannot retain a stale live badge. */
export function isWeatherFresh(weather, now = Date.now()) {
  const age = observationAge(weather, now);
  return Number.isFinite(age) && age >= -CLOCK_TOLERANCE_MS && age <= FRESH_WEATHER_MS;
}
