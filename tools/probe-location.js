#!/usr/bin/env node
/* ============================================================================
 * probe-location.js —— 实测「按 IP 定位城市」这条链：每个源分别说什么、谁先应答、谁挂了
 * ----------------------------------------------------------------------------
 * 为什么要有这个工具：
 *   定位的**准确性只能实测** —— 各家 IP 库对同一个 IP 的归属经常不一致。
 *   实测（2026-10-01，本机出口 IP 112.20.10.15 / 中国移动 AS56046）：
 *     ipinfo → Shanghai · ipwho.is / ipwhois.app / geolocation-db / ip2location → Beijing
 *     bigdatacloud → 泰州市 / 高港区
 *   降级链的**顺序就是被这份输出决定的**，所以顺序不能靠拍脑袋，得能重跑复核。
 *
 * ★ 它同时是"准不准"的自检：`--chain` 输出的第一条就是**你会看到的那座城市**。
 *   如果你人在 A 城却显示 B 城，说明该把更细的源往前提 ——
 *   改 `src/lib/environment.js` 的 `LOCATION_PROVIDERS` 顺序即可，别处没有依赖。
 *
 * 跑法：
 *   node tools/probe-location.js            # 逐源单独打（绕过降级链），出对照表
 *   node tools/probe-location.js --chain    # 只跑真正的降级链，报"谁赢了 + 花了多久"
 * ========================================================================== */

import { lookupApproximateCity, LOCATION_PROVIDERS } from '../src/lib/environment.js';

/** 中英混排的等宽补齐：一个汉字算两格，否则表会歪。 */
const zh = (value, width) => {
  const text = String(value);
  const cells = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - cells));
};

/* ------------------------------------------------------ 1. 真·降级链 */

async function probeChain() {
  const hosts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { hosts.push(new URL(url).host); return realFetch(url, init); };
  const started = Date.now();
  try {
    const city = await lookupApproximateCity();
    globalThis.fetch = realFetch;
    console.log(`✔ 定位成功，用时 ${Date.now() - started}ms`);
    console.log(`  尝试顺序：${hosts.join(' → ')}`);
    console.log(`  ⇒ 赢家：${hosts[hosts.length - 1]}（前 ${hosts.length - 1} 个失败）`);
    console.log(`  结果：${city.name} · ${city.country || '(无国家)'} · ${city.latitude}, ${city.longitude}`);
    console.log(`  字段：${Object.keys(city).sort().join(', ')}`);
    const leaked = ['ip', 'ipv4', 'ipv6', 'asn', 'timezone', 'postal', 'org'].filter((key) => key in city);
    console.log(`  网络元数据泄漏：${leaked.length ? '⚠️ ' + leaked.join(', ') : '无 ✔'}`);
    return 0;
  } catch (error) {
    globalThis.fetch = realFetch;
    console.log(`✘ 定位失败，用时 ${Date.now() - started}ms`);
    console.log(`  尝试顺序：${hosts.join(' → ') || '(一次都没发出去)'}`);
    console.log(`  ${error.name}: ${error.message}`);
    console.log(`  最后原因：${error.cause?.name ?? '-'} · ${error.cause?.message ?? '-'}`);
    return 1;
  }
}

/* ------------------------------------------------- 2. 逐源单独打（对照表） */

async function probeEach() {
  console.log(`${zh('源', 16)}${zh('HTTP', 7)}${zh('城市', 14)}${zh('坐标', 26)}${zh('中文名', 8)}${zh('耗时', 9)}备注`);
  console.log('-'.repeat(104));
  for (const provider of LOCATION_PROVIDERS) {
    const url = provider.request();
    const started = Date.now();
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await response.text();
      const ms = `${Date.now() - started}ms`;
      let city = '-', coords = '-', note = '', chinese = '-';
      try {
        const data = JSON.parse(text);
        // 走各自的 parse —— 这才测的是"链真正会拿到什么"，而不是我在这儿另解一遍。
        const parsed = provider.parse(data);
        city = parsed?.name ?? '-';
        coords = parsed ? `${parsed.latitude.toFixed(3)}, ${parsed.longitude.toFixed(3)}` : '-';
        chinese = parsed ? (/[\u4e00-\u9fa5]/.test(parsed.name) ? '✔' : '✘') : '-';
        note = [data.lookupSource, data.principalSubdivision, data.region_name, data.countryName || data.country]
          .filter(Boolean).join(' · ');
      } catch {
        note = text.slice(0, 56).replace(/\s+/g, ' ');
      }
      console.log(`${zh(provider.id, 16)}${zh(response.status, 7)}${zh(city, 14)}${zh(coords, 26)}${zh(chinese, 8)}${zh(ms, 9)}${note}`);
    } catch (error) {
      console.log(`${zh(provider.id, 16)}${zh('ERR', 7)}${zh('-', 14)}${zh('-', 26)}${zh('-', 8)}${zh('-', 9)}${error.name}: ${error.message}`);
    }
  }
  console.log('\n（「中文名」列 ✘ 的源返回英文城市名，会走 environment.js 里的反查表兜一层）');
}

if (process.argv.includes('--chain')) {
  process.exit(await probeChain());
}
await probeEach();
console.log('\n（想看真正的降级链：node tools/probe-location.js --chain）');
