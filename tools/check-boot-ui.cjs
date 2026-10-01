/* 5 秒白屏烟测：Electron 窗口里 App 是否真的渲染出来了。
 *
 * 为什么需要它：React 的 hook 依赖数组（useMemo/useCallback/useEffect 的第二个参数）
 * 是在**调用那一刻**求值的。把 `const [x] = useState()` 写在用到 x 的 useMemo 之后，
 * 会踩 TDZ（ReferenceError）—— 整棵树白屏，而 `vite build` 与 `node --test` **都发现不了**
 * （构建只做模块级静态分析，单元测试根本不 import App.jsx）。
 * 本轮实装就踩过一次：options 的 deps 里引了声明在下面的 initialSave。
 *
 * 跑法：node tools/check-boot-ui.cjs 9223
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const PORT = process.argv[2] || '9223';

async function connect(tries = 10) {
  for (let i = 0; i < tries; i++) {
    try { return await PW.chromium.connectOverCDP('http://127.0.0.1:' + PORT); }
    catch { await new Promise(r => setTimeout(r, 1500)); }
  }
  throw new Error('连不上 CDP ' + PORT);
}

(async () => {
  const browser = await connect();
  const ctx = browser.contexts()[0];
  const page = (ctx ? ctx.pages() : []).find(p => /5188|浮生|pond/i.test(p.url())) || ctx.pages()[0];
  if (!page) throw new Error('没有可用页面');
  await page.waitForTimeout(1500);

  // 收集页面自身的报错 —— 白屏时这里应该有 ReferenceError
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const state = await page.evaluate(() => {
    const root = document.getElementById('root');
    return {
      rootChildren: root ? root.childElementCount : -1,
      main: !!document.querySelector('main.app'),
      canvas: !!document.querySelector('canvas.pond-canvas'),
      settingsButton: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '设置'),
      sceneStatus: document.querySelector('.scene-status')?.textContent.replace(/\s+/g, ' ').trim() || '',
    };
  });

  const checks = [
    ['#root 已挂载子节点', state.rootChildren > 0, `childElementCount=${state.rootChildren}`],
    ['<main class="app"> 在位', state.main],
    ['画布已挂载（含读档门控放行）', state.canvas],
    ['工具栏按钮渲染出来', state.settingsButton],
    ['左下角状态有内容', state.sceneStatus.length > 0, state.sceneStatus],
  ];
  let ok = true;
  for (const [label, cond, detail] of checks) {
    console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? '  — ' + detail : ''}`);
    ok = ok && cond;
  }
  if (errors.length) console.log('  页面报错：\n    ' + errors.join('\n    '));
  else console.log('  ✔ 无未捕获的页面异常');

  await browser.close();
  console.log('\n结果:', ok ? '✔ App 正常渲染' : '✘ 疑似白屏');
  setTimeout(() => process.reallyExit(ok && errors.length === 0 ? 0 : 1), 200);
})().catch(e => { console.log('FAILED: ' + e.message); process.reallyExit(2); });
