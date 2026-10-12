// 逐状态普查：驱动界面走到各个界面/菜单/对话框，收集仍未汉化的英文文本与属性
import fs from 'node:fs';
import { listTargets, Cdp } from './lib/cdp.mjs';

const PORT = Number(process.argv[2] || 9333);
const OUT = process.argv[3] || 'sweep.json';
const STEPS = JSON.parse(fs.readFileSync(process.argv[4] || 'sweep-steps.json', 'utf8'));

const HARVEST = String.raw`(() => {
  const hasCjk = (s) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { if (!el || el.nodeType !== 1) return false; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const skip = (el) => el && (el.closest('.monaco-editor') || el.closest('[data-zh-ignore]'));
  const texts = new Set(), attrs = new Set(), clickable = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = clean(n.nodeValue);
    if (!t || t.length > 300 || hasCjk(t) || !/[A-Za-z]/.test(t)) continue;
    if (visible(n.parentElement) && !skip(n.parentElement)) texts.add(t);
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    if (!visible(el) || skip(el)) continue;
    for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
      const v = clean(el.getAttribute(a));
      if (v && v.length <= 300 && !hasCjk(v) && /[A-Za-z]/.test(v)) attrs.add(v);
    }
  }
  for (const el of document.querySelectorAll('a,button,[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[role="switch"]')) {
    if (!visible(el)) continue;
    const label = clean(el.getAttribute('aria-label') || el.textContent);
    if (label && label.length <= 60) clickable.add(label);
  }
  return { url: location.pathname + location.search, texts: [...texts].sort(), attrs: [...attrs].sort(), clickable: [...clickable].sort() };
})()`;

const CLICK = (label) => String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const all = [...document.querySelectorAll('a,button,[role="button"],[role="menuitem"],[role="tab"],[role="option"]')].filter(visible);
  const want = ${JSON.stringify(label)};
  const el = all.find((e) => clean(e.getAttribute('aria-label')) === want) ||
             all.find((e) => clean(e.textContent) === want) ||
             all.find((e) => clean(e.getAttribute('aria-label')).startsWith(want)) ||
             all.find((e) => clean(e.textContent).startsWith(want));
  if (!el) return 'NOT_FOUND:' + want;
  el.click();
  return 'OK';
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function attach() {
  const ts = await listTargets(PORT);
  const t = ts.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!t) throw new Error('没有 page 目标');
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

fs.mkdirSync('sweep-shots', { recursive: true });
const texts = new Map(), attrs = new Map(), log = [];
let cdp = await attach();

for (const step of STEPS) {
  if (step.reload) { await cdp.send('Page.reload', {}); await sleep(5000); }
  if (step.type) {
    await cdp.eval("(() => { const el = document.activeElement; return el ? el.tagName : 'none'; })()");
    await cdp.send('Input.insertText', { text: step.type });
    await sleep(900);
  }
  if (step.esc) { await cdp.eval("['Escape','Escape'].forEach(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))); true"); await sleep(400); }
  const results = [];
  for (const label of step.clicks || []) {
    try { const r = await cdp.eval(CLICK(label)); results.push(label + '→' + r); } catch (e) { results.push(label + '→ERR'); }
    await sleep(step.wait || 1200);
  }
  if (step.scroll) {
    for (let i = 0; i < (step.scroll || 0); i += 1) {
      await cdp.eval("(() => { const el = document.querySelector('[data-scroll], main, .overflow-y-auto') || document.scrollingElement; el.scrollTop = el.scrollHeight; window.scrollTo(0, document.body.scrollHeight); return true; })()");
      await sleep(900);
    }
  }
  let data;
  try { data = await cdp.eval(HARVEST); } catch (e) { cdp = await attach(); data = await cdp.eval(HARVEST); }
  const name = step.name;
  for (const t of data.texts) { if (!texts.has(t)) texts.set(t, []); if (!texts.get(t).includes(name)) texts.get(t).push(name); }
  for (const a of data.attrs) { if (!attrs.has(a)) attrs.set(a, []); if (!attrs.get(a).includes(name)) attrs.get(a).push(name); }
  log.push({ name, url: data.url, clicks: results, textCount: data.texts.length, attrCount: data.attrs.length, clickable: step.dumpClickable ? data.clickable : undefined });
  console.log('[' + name + '] ' + data.url + ' 未汉化文本 ' + data.texts.length + '/' + texts.size + '，属性 ' + data.attrs.length + '/' + attrs.size + (step.clicks && step.clicks.length ? '  点击: ' + results.join(' ') : ''));
  if (step.snap) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('sweep-shots/' + name + '.png', Buffer.from(shot.data, 'base64'));
  }
}

fs.writeFileSync(OUT, JSON.stringify({ steps: log, texts: [...texts.keys()].sort(), textStates: Object.fromEntries(texts), attrs: [...attrs.keys()].sort(), attrStates: Object.fromEntries(attrs) }, null, 2), 'utf8');
console.log('\n未汉化唯一文本 ' + texts.size + ' 条，唯一属性 ' + attrs.size + ' 条 → ' + OUT);
cdp.close();
