// 收集市场目录里所有仍为英文的可见文本（滚动加载 + 去重）
import fs from 'node:fs';
import { listTargets, Cdp } from './lib/cdp.mjs';
const PORT = Number(process.argv[2] || 9333);
const targets = await listTargets(PORT);
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HARVEST = String.raw`(() => {
  const hasCjk = (s) => /[\u3400-\u9fff]/.test(s);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { if (!el || el.nodeType !== 1) return false; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = clean(n.nodeValue);
    if (!t || t.length > 400 || hasCjk(t) || !/[A-Za-z]/.test(t)) continue;
    if (visible(n.parentElement)) out.push(t);
  }
  return out;
})()`;

const SCROLL = "(() => { let best = null; for (const el of document.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300) { if (!best || el.scrollHeight > best.scrollHeight) best = el; } } const t = best || document.scrollingElement; t.scrollTop = t.scrollTop + Math.floor(t.clientHeight * 0.85); return Math.round(t.scrollTop) + '/' + Math.round(t.scrollHeight); })()";

// 先回到顶部，再逐屏向下收集
await cdp.eval("(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 300) { el.scrollTop = 0; } } if (document.scrollingElement) document.scrollingElement.scrollTop = 0; return true; })()");
await sleep(1200);
const seen = new Map();
let last = '';
let stale = 0;
for (let i = 0; i < 200 && stale < 8; i += 1) {
  const items = await cdp.eval(HARVEST);
  const before = seen.size;
  for (const it of items) if (!seen.has(it)) seen.set(it, i);
  const pos = await cdp.eval(SCROLL);
  if (seen.size === before) stale += 1; else stale = 0;
  if (i % 5 === 0 || pos === last) console.log('  轮次 ' + i + '：已收集 ' + seen.size + ' 条，位置 ' + pos);
  last = pos;
  await sleep(650);
}
const arr = [...seen.keys()].sort();
fs.writeFileSync('catalog.json', JSON.stringify(arr, null, 2), 'utf8');
const descs = arr.filter((s) => s.startsWith('MCP Servers ·'));
console.log('\n目录内英文条目 ' + arr.length + '（其中 MCP 描述 ' + descs.length + '）→ catalog.json');
console.log(arr.slice(0, 25).map((s) => '  ' + s).join('\n'));
cdp.close();
