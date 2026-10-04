/**
 * 桌面启动失败的取证 —— 补`check-desktop-boot.cjs` 的盲区。
 *
 * ★★ 为什么需要它：量具的 `pageerror` / `console` 监听是在**断言前**挂的，
 *   而 React 挂载失败（TDZ 白屏之类）往往发生在**页面 load 的那一瞬间** ——
 *   等监听挂上时，异常已经抛完了，于是④ 报「0 条异常」，
 *   而 ⑤canvas=0 / ⑥root 子节点=0。**看起来像"静默失败"，实际异常被漏采了。**
 *   教训与记忆里那条一致：判据失效时先确认「它拿到的是不是它以为的东西」。
 *
 * 做法：CDP 连上后**先开 Log/Runtime 域并回放**，
 *   再用 `Runtime.evaluate` 主动捞 `window.__errs`（main.cjs 里若有记录），
 *   并把 body 真实 HTML 打出来 —— 白屏时它通常只有 `<div id="root"></div>`。
 */
const PW = require('C:/Users/Y/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const PORT = process.env.POND_DESKTOP_PORT || '4182';
const CDP = process.env.POND_CDP_PORT || '9227';
const SITE = `http://127.0.0.1:${PORT}/`;

(async () => {
  // launch-desktop.cjs 自包含（静态伺服 +拉起 Electron），与 check-desktop-boot 同款
  const launcher = spawn(process.execPath, [join(ROOT, 'tools', 'launch-desktop.cjs')], {
    cwd: ROOT, env: { ...process.env, POND_DESKTOP_PORT: PORT, POND_CDP_PORT: CDP },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let eout = '';
  launcher.stdout.on('data', (d) => { eout += d; });
  launcher.stderr.on('data', (d) => { eout += d; });

  let cdp = null;
  for (let i = 0; i < 40; i++) {
    try { cdp = await PW.chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (!cdp) { console.log('✘ CDP 连不上\n' + eout.slice(0, 1500)); launcher.kill(); process.exit(1); }

  const ctx = cdp.contexts()[0];
  const page = ctx.pages()[0];
  // ★ 关键：先挂监听，再等页面跑一会儿
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => ({
    url: location.href,
    canvas: document.querySelectorAll('canvas').length,
    rootKids: document.getElementById('root')?.childElementCount ?? -1,
    bodyHtml: document.body.innerHTML.slice(0, 600),
    scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src),
  }));
  console.log('\n=== 页面状态 ===');
  console.log('url      ', info.url);
  console.log('canvas   ', info.canvas);
  console.log('rootKids ', info.rootKids);
  console.log('scripts  ', info.scripts.join('\n          '));
  console.log('bodyHtml ', info.bodyHtml);
  console.log('\n=== 捕获的异常（' + errors.length + ' 条）===');
  for (const e of errors.slice(0, 6)) console.log(e.slice(0, 900));
  if (!errors.length) console.log('（无 —— 说明异常发生在监听挂上之前，或确实没抛异常）');
  console.log('\n=== electron stdout/stderr ===');
  console.log(eout.slice(0, 1500) || '（空）');

  launcher.kill();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });