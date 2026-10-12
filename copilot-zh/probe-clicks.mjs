// 列出界面上的可点击入口，供遍历采集用
import { listTargets, Cdp } from './lib/cdp.mjs';
const PORT = Number(process.argv[2] || 9333);
const targets = await listTargets(PORT);
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
const SRC = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const out = [];
  for (const el of document.querySelectorAll('a,button,[role="button"],[role="menuitem"],[role="tab"],summary')) {
    if (!visible(el)) continue;
    const label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
    if (!label || label.length > 60) continue;
    out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label, cls: (el.className || '').toString().slice(0, 40) });
  }
  const uniq = new Map();
  for (const o of out) { const k = o.tag + '|' + o.label; if (!uniq.has(k)) uniq.set(k, o); }
  return [...uniq.values()];
})()`;
const items = await cdp.eval(SRC);
console.log('可点击入口 ' + items.length + ' 个：');
for (const i of items) console.log('  [' + i.tag + (i.role ? '/' + i.role : '') + '] ' + i.label);
cdp.close();
