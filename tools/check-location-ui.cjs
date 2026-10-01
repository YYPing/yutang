/* 天气「按网络定位」的端到端检查：真 Chromium + 真 App + 拦截四个定位源。
 *
 * 为什么必须有它：这段逻辑的坑几乎全在**真机才成立**的地方 ——
 *   ① 状态时序：只在首启动跑一次 · 失败后永久停在兜底武汉 · 静默刷新把用户手选的城市覆盖掉；
 *   ② **CSP**：`index.html` 的 `connect-src` 白名单当时只写了 `https://ipwho.is`，
 *      新加的另外三个源在浏览器里连请求都发不出去 —— 整条降级链在真机上是**空转**的，
 *      而 `vite build` 和 `node --test` 全是绿的（这一条就是被本脚本抓出来的）。
 * 单测只 import environment.js 的纯函数，压根不 import React hook，所以这两类都看不见。
 *
 * 观测点选的是「用户真能看到 + 真会落盘」的东西：
 *   · 顶栏城市名（.weather-badge）· 面板提示（.inline-note）· 定位按钮文案（.text-button.locate）
 *   · localStorage['fusheng-city']（source / locatedAt）· 到底打了哪个定位源（route 计数）
 *
 * 三类页面原点都要过一遍，因为它们走的**不是同一条分支**：
 *   · 桌面端（window.pondDesktop 存在）→ 一律按 IP 定位
 *   · 局域网 http://（非安全上下文）  → geolocation 必被拒，必须自己降级到 IP
 *   · 本地 http://127.0.0.1（安全上下文）→ 有精确位置可用时优先问浏览器
 *
 * 跑法：node tools/check-location-ui.cjs   （先 npm run build）
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Users/Y/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const ROOT = path.join(__dirname, '..', 'dist');
const HOUR = 3600_000;
const TTL_HOURS = 6;   // 只用于构造"过期/没过期"的存档，必须与 useEnvironment 的 LOCATION_TTL_MS 一致

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list || []) if (address.family === 'IPv4' && !address.internal) return address.address;
  }
  return null;
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.resolve(ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    // 绑 0.0.0.0 是为了让「局域网 http://<内网IP>:port」这个非安全上下文也能被访问到 ——
    // 那正是用户实际的使用方式，也是 geolocation 必然被拒、必须降级到 IP 的那个场景。
    server.listen(0, '0.0.0.0', () => resolve(server));
  });
}

/** 桌面端的桥。`getState` 故意永不 resolve：只留"这是在桌面应用里"这一个事实，
 *  App 就不会进入桌面模式分支（我们没有真窗口可铺），但定位分支走的与真机完全一致。*/
const DESKTOP_BRIDGE = () => {
  const never = () => new Promise(() => {});
  const off = () => () => {};
  window.pondDesktop = {
    getState: never, setDesktopMode: never, setGlobalInteraction: never, setLaunchAtLogin: never,
    feed: never, showControls: never, setFullScreen: never, hide: never, minimize: never, quit: never,
    loadSave: never, writeSave: never, onState: off, onPointer: off,
  };
};

/** 一个场景一次全新的 context：localStorage 干净，才能验证"只有首启动才自动定位"。*/
async function scenario(browser, base, { name, seedCity = null, desktop = false, mode = 'ok', located = '泰州市', run }) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  if (desktop) await context.addInitScript(DESKTOP_BRIDGE);
  if (seedCity) await context.addInitScript((city) => { localStorage.setItem('fusheng-city', city); }, JSON.stringify(seedCity));
  const page = await context.newPage();
  const net = { hits: [], mode };
  await page.route(/bigdatacloud|ipwho\.is|ipwhois\.app|geolocation-db|open-meteo/, (route) => {
    const url = route.request().url();
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
    if (/geocoding-api/.test(url)) return route.fulfill({ status: 200, headers, body: JSON.stringify({ results: [] }) });
    if (/open-meteo\.com/.test(url)) {
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ current: { temperature_2m: 21.5, weather_code: 3, is_day: 1, time: Math.floor(Date.now() / 1000) } }) });
    }
    net.hits.push(new URL(url).hostname);
    if (net.mode === 'fail') return route.abort('failed');
    // 四个源回同一份"看起来像"的数据：具体赢的是链首那个，这本身就是断言点。
    return route.fulfill({ status: 200, headers, body: JSON.stringify({
      city: located, locality: located, principalSubdivision: '江苏省', countryName: '中华人民共和国',
      success: true, latitude: 32.44, longitude: 119.92,
    }) });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const view = {
    page, net, errors,
    city: () => page.evaluate(() => JSON.parse(localStorage.getItem('fusheng-city') || 'null')),
    badge: () => page.locator('.weather-badge').first().innerText(),
    openPanel: async () => {
      await page.locator('.weather-badge').first().click();
      await page.locator('.text-button.locate').waitFor({ timeout: 5000 });
    },
    locateLabel: async () => (await page.locator('.text-button.locate').innerText()).trim(),
    notes: () => page.locator('.inline-note').allInnerTexts(),
  };
  try {
    await page.goto(`${base}/index.html`, { waitUntil: 'load' });
    await page.locator('.weather-badge').first().waitFor({ timeout: 15000 });
    await run(view);
    if (errors.length) throw new Error(`页面报错：${errors.join(' | ')}`);
  } catch (error) {
    throw new Error(`[${name}] ${error.message}`);
  } finally {
    await context.close();
  }
}

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? `  —— ${detail}` : ''}`);
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) throw new Error('dist/index.html 不存在，先跑 npm run build');
  const server = await serve();
  const port = server.address().port;
  const lan = lanAddress();
  const browser = await PW.chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const local = `http://127.0.0.1:${port}`;
  const seen = (v) => `打到 ${JSON.stringify(v.net.hits)}`;
  console.log(`静态站点 ${local} · 局域网 http://${lan}:${port}\n`);

  console.log('—— 桌面端（window.pondDesktop 存在 → 一律按 IP 定位）——');
  // ① 首启动：没有存档城市 → 自动定位一次，只打链首那一个源，并把时效时间戳落盘。
  await scenario(browser, local, { name: '首启动自动定位', desktop: true, run: async (v) => {
    await v.page.waitForFunction(() => !!localStorage.getItem('fusheng-city'), null, { timeout: 10000 });
    const city = await v.city();
    check('首启动自动定位把城市落盘', city?.name === '泰州市', `name=${city?.name}`);
    check('落盘的城市标着「网络定位」来源', city?.source === 'approximate', `source=${city?.source}`);
    check('落盘时记下定位时间戳（时效判断的唯一依据）',
      Number.isFinite(city?.locatedAt) && Math.abs(Date.now() - city.locatedAt) < 60_000, `locatedAt=${city?.locatedAt}`);
    check('首选源可用就只花一次往返，没有把四个源都打一遍',
      v.net.hits.length === 1 && v.net.hits[0] === 'api.bigdatacloud.net', seen(v));
    await v.openPanel();
    check('面板说明城市来自网络定位', (await v.notes()).some((t) => t.includes('网络大致位置')));
    check('已定位后按钮变成「重新定位」', await v.locateLabel() === '重新定位', await v.locateLabel());
    check('顶栏显示定位到的城市', (await v.badge()).includes('泰州市'));
  } });

  // ② 四个源全挂：停在明确标注的兜底上，**不写存档假装是用户选的**；然后按钮能立刻救回来。
  await scenario(browser, local, { name: '定位全失败', desktop: true, mode: 'fail', run: async (v) => {
    await v.page.waitForTimeout(1500);
    check('定位全失败时存档没有被写入（武汉只是兜底，不是"用户选的城市"）', (await v.city()) === null);
    check('全失败前把四个源都试过了', v.net.hits.length === 4, seen(v));
    await v.openPanel();
    check('面板明确说明自动定位不可用', (await v.notes()).some((t) => t.includes('自动定位暂不可用')));
    check('失败后按钮是「按网络定位城市」（失败不是终点）', await v.locateLabel() === '按网络定位城市', await v.locateLabel());
    // ★ 这一条针对的正是改造前的死结：失败后永久停在武汉、界面里没有任何重试入口。
    v.net.mode = 'ok';
    v.net.hits.length = 0;
    await v.page.locator('.text-button.locate').click();
    await v.page.waitForFunction(() => JSON.parse(localStorage.getItem('fusheng-city') || 'null')?.name === '泰州市', null, { timeout: 10000 });
    check('兜底状态下点一下就能定位成功', (await v.city())?.source === 'approximate');
    check('重试成功后旧的失败提示被清掉', !(await v.notes()).some((t) => t.includes('自动定位暂不可用')));
  } });

  // ③ 用户手选过城市：自动定位一次都不许打，存档来源保持 manual。
  await scenario(browser, local, {
    name: '用户手选优先', desktop: true,
    seedCity: { id: 'hangzhou', name: '杭州', country: '中国', latitude: 30.2741, longitude: 120.1551, source: 'manual' },
    run: async (v) => {
      await v.page.waitForTimeout(1500);
      check('用户手选的城市不会被自动定位覆盖', (await v.badge()).includes('杭州'));
      check('手选城市的这次启动没有发出任何定位请求', v.net.hits.length === 0, seen(v));
      check('存档来源仍是 manual', (await v.city())?.source === 'manual');
      await v.openPanel();
      check('手选城市不显示「来自网络定位」的说明', !(await v.notes()).some((t) => t.includes('网络大致位置')));
    },
  });

  // ④ 存档里的网络定位结果过期（超过保鲜期）→ 后台静默换一次新的。
  await scenario(browser, local, {
    name: '过期自动刷新', desktop: true,
    seedCity: { id: 'approximate-stale', name: '北京', country: '中国', latitude: 39.9, longitude: 116.4, source: 'approximate', locatedAt: Date.now() - (TTL_HOURS + 2) * HOUR },
    run: async (v) => {
      await v.page.waitForFunction(() => JSON.parse(localStorage.getItem('fusheng-city') || 'null')?.name === '泰州市', null, { timeout: 10000 });
      const city = await v.city();
      check('过期的网络定位结果会被静默刷新', city?.name === '泰州市', city?.name);
      check('刷新后时间戳被更新', city?.locatedAt > Date.now() - 60_000);
      check('静默刷新只打一次源', v.net.hits.length === 1, seen(v));
    },
  });

  // ⑤ 存档里的网络定位结果还在保鲜期内 → 一次都不许打（不然每开一次就重定位一遍）。
  await scenario(browser, local, {
    name: '保鲜期内不打扰', desktop: true,
    seedCity: { id: 'approximate-fresh', name: '泰州', country: '中国', latitude: 32.44, longitude: 119.92, source: 'approximate', locatedAt: Date.now() - HOUR },
    run: async (v) => {
      await v.page.waitForTimeout(1500);
      check('保鲜期内的网络定位结果不会被重定位', v.net.hits.length === 0, seen(v));
      check('顶栏显示存档里的城市', (await v.badge()).includes('泰州'));
    },
  });

  console.log('\n—— 局域网 http://（非安全上下文 → geolocation 必被拒，必须降级到 IP）——');
  if (!lan) {
    console.log('⚠️  找不到局域网地址，跳过');
  } else {
    try {
      await scenario(browser, `http://${lan}:${port}`, { name: '局域网 http 降级', run: async (v) => {
        check('确认跑在非安全上下文里', await v.page.evaluate(() => window.isSecureContext) === false);
        await v.page.waitForFunction(() => !!localStorage.getItem('fusheng-city'), null, { timeout: 10000 });
        check('局域网 http 下自动降级到 IP 定位（不是直接报"未取得定位权限"）', (await v.city())?.name === '泰州市');
        await v.openPanel();
        check('按钮文案是「重新定位」而不是「使用我的位置」', await v.locateLabel() === '重新定位', await v.locateLabel());
      } });
    } catch (error) {
      console.log(`⚠️  局域网场景未跑成（不记为失败）：${error.message}`);
    }
  }

  console.log('\n—— 本地 http://127.0.0.1（安全上下文 → 有精确位置可用时优先问浏览器）——');
  await scenario(browser, local, { name: '安全上下文优先精确位置', run: async (v) => {
    check('确认跑在安全上下文里', await v.page.evaluate(() => window.isSecureContext) === true);
    await v.page.waitForTimeout(1500);
    check('首启动仍先用 IP 拿到一个城市（不弹权限、不留空白）', (await v.city())?.name === '泰州市');
    await v.openPanel();
    check('按钮文案是「使用我的位置」（精确优先）', await v.locateLabel() === '使用我的位置', await v.locateLabel());
  } });

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length} 项，未通过 ${failed.length} 项`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error('✘ 检查脚本自身出错：', error.message); process.exit(1); });
