// 找出界面上仍是英文（未汉化）的可见文本与属性
import { listTargets, Cdp } from './lib/cdp.mjs';
const PORT = Number(process.argv[2] || 9333);
const targets = await listTargets(PORT);
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
const SRC = String.raw`(() => {
  const hasCjk = (s) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { if (!el || el.nodeType !== 1) return false; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const skip = (el) => el && (el.closest('.monaco-editor') || el.closest('[data-zh-ignore]'));
  const texts = new Set(), attrs = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = clean(n.nodeValue);
    if (!t || t.length > 200 || hasCjk(t) || !/[A-Za-z]/.test(t)) continue;
    if (visible(n.parentElement) && !skip(n.parentElement)) texts.add(t);
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    if (!visible(el) || skip(el)) continue;
    for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
      const v = clean(el.getAttribute(a));
      if (v && v.length <= 200 && !hasCjk(v) && /[A-Za-z]/.test(v)) attrs.add(v);
    }
  }
  return { url: location.href, texts: [...texts].sort(), attrs: [...attrs].sort() };
})()`;
const d = await cdp.eval(SRC);
console.log('当前界面: ' + d.url);
console.log('\n=== 未汉化文本 (' + d.texts.length + ') ===');
for (const t of d.texts) console.log('  ' + t);
console.log('\n=== 未汉化属性 (' + d.attrs.length + ') ===');
for (const t of d.attrs) console.log('  ' + t);
cdp.close();
