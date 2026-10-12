// 小工具: node act.mjs <click|snap|reload|text> [参数]
import fs from 'node:fs';
import { listTargets, Cdp } from './lib/cdp.mjs';

const [cmd, a1, a2] = process.argv.slice(2);
const PORT = Number(process.env.ZH_PORT || 9333);
const targets = await listTargets(PORT);
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === 'click') {
  const r = await cdp.eval(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const all = [...document.querySelectorAll('a,button,[role="button"],[role="menuitem"],[role="tab"]')].filter(visible);
    const want = ${JSON.stringify(a1)};
    const el = all.find((e) => clean(e.getAttribute('aria-label')) === want) ||
               all.find((e) => clean(e.textContent) === want) ||
               all.find((e) => clean(e.getAttribute('aria-label')).startsWith(want)) ||
               all.find((e) => clean(e.textContent).startsWith(want));
    if (!el) return 'NOT_FOUND';
    el.click();
    return 'CLICKED: ' + clean(el.getAttribute('aria-label') || el.textContent).slice(0, 60);
  })()`);
  console.log(r);
  await wait(1500);
} else if (cmd === 'snap') {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(a1, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + a1);
} else if (cmd === 'reload') {
  await cdp.send('Page.reload', {});
  await wait(Number(a1 || 4000));
  console.log('已重载页面');
} else if (cmd === 'text') {
  const t = await cdp.eval("document.body.innerText.split('\\n').map(s=>s.trim()).filter(Boolean).slice(0, 80)");
  console.log(t.join('\n'));
}
cdp.close();
