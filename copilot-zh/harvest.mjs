// 采集 Copilot 界面上的可见文本 / 属性文本，供汉化词典使用
import { listTargets, Cdp } from './lib/cdp.mjs';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 9333);
const OUT = process.argv[3] || 'dom-strings.json';

const COLLECT = String.raw`(() => {
  const texts = new Set();
  const attrs = new Set();
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = clean(n.nodeValue);
    if (!t || t.length > 120) continue;
    if (!/[A-Za-z]/.test(t)) continue;
    if (visible(n.parentElement)) texts.add(t);
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    if (!visible(el)) continue;
    for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
      const v = clean(el.getAttribute(a));
      if (v && v.length <= 120 && /[A-Za-z]/.test(v)) attrs.add(v);
    }
  }
  return {
    url: location.href,
    title: document.title,
    texts: [...texts].sort(),
    attrs: [...attrs].sort(),
    bodyClasses: document.body.className,
    lang: document.documentElement.lang,
  };
})()`;

const targets = await listTargets(PORT);
console.log('目标列表：');
for (const t of targets) console.log(' -', t.type, '|', t.title, '|', t.url, '|', t.webSocketDebuggerUrl ? 'ws ok' : 'no ws');

const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets.find((t) => t.webSocketDebuggerUrl);
if (!page) { console.error('没有可连接的目标'); process.exit(1); }
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
const data = await cdp.eval(COLLECT);
fs.writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');
console.log('\n页面:', data.url, '| lang=' + JSON.stringify(data.lang), '| body.class=' + JSON.stringify(data.bodyClasses));
console.log('可见文本 ' + data.texts.length + ' 条，属性文本 ' + data.attrs.length + ' 条 → ' + OUT);
console.log('\n前 60 条文本：');
for (const t of data.texts.slice(0, 60)) console.log('  ' + t);
cdp.close();
