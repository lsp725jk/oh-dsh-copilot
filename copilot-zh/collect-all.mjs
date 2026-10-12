// 逐屏采集 Copilot 界面文本（并截图留档）
import { listTargets, Cdp } from './lib/cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] || 9333);
const OUTDIR = process.argv[3] || 'collect';
fs.mkdirSync(path.join(OUTDIR, 'shots'), { recursive: true });

const HARVEST = String.raw`(() => {
  const texts = new Set(), attrs = new Set();
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = clean(n.nodeValue);
    if (!t || t.length > 160 || !/[A-Za-z]/.test(t)) continue;
    if (visible(n.parentElement)) texts.add(t);
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    if (!visible(el)) continue;
    for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
      const v = clean(el.getAttribute(a));
      if (v && v.length <= 160 && /[A-Za-z]/.test(v)) attrs.add(v);
    }
  }
  return { url: location.href, texts: [...texts], attrs: [...attrs] };
})()`;

const CLICK = (label) => String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const all = [...document.querySelectorAll('a,button,[role="button"],[role="menuitem"],[role="tab"]')].filter(visible);
  const want = ${JSON.stringify(label)};
  let el = all.find((e) => clean(e.getAttribute('aria-label')) === want) ||
           all.find((e) => clean(e.textContent) === want) ||
           all.find((e) => clean(e.getAttribute('aria-label')).startsWith(want)) ||
           all.find((e) => clean(e.textContent).startsWith(want));
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'CLICKED:' + clean(el.getAttribute('aria-label') || el.textContent).slice(0, 60);
})()`;

async function page() {
  const ts = await listTargets(PORT);
  const t = ts.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!t) throw new Error('没有 page 目标');
  return { t, cdp: await Cdp.connect(t.webSocketDebuggerUrl) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const all = new Map();      // 字符串 -> 出现过的屏
const attrsAll = new Map();
const screens = [];

async function capture(cdp, name) {
  const data = await cdp.eval(HARVEST);
  for (const t of data.texts) {
    if (!all.has(t)) all.set(t, []);
    if (!all.get(t).includes(name)) all.get(t).push(name);
  }
  for (const a of data.attrs) {
    if (!attrsAll.has(a)) attrsAll.set(a, []);
    if (!attrsAll.get(a).includes(name)) attrsAll.get(a).push(name);
  }
  screens.push({ name, url: data.url, textCount: data.texts.length });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUTDIR, 'shots', name + '.png'), Buffer.from(shot.data, 'base64'));
  console.log('  [' + name + '] 文本 ' + data.texts.length + ' 条，累计 ' + all.size + ' 条');
}

const steps = [
  { name: 'home', action: null },
  { name: 'customize', action: 'Customize', back: true },
  { name: 'automations', action: 'Automations', back: true },
  { name: 'issues', action: 'Issues', back: true },
  { name: 'pull-requests', action: 'Pull requests', back: true },
  { name: 'command-palette', action: 'Search', esc: true },
  { name: 'settings', action: 'Settings', esc: true },
  { name: 'user-menu', action: 'lsp725jk, open user menu', esc: true },
  { name: 'mode-menu', action: 'Mode: Interactive', esc: true },
  { name: 'model-menu', action: 'Default, model and reasoning', esc: true },
  { name: 'context-menu', action: 'Add context & more', esc: true },
  { name: 'configure-sessions', action: 'Configure sessions', esc: true },
];

for (const step of steps) {
  let { cdp } = await page();
  await cdp.send('Runtime.enable');
  if (step.action) {
    const r = await cdp.eval(CLICK(step.action));
    console.log('-> ' + step.name + ' 点击 ' + step.action + ' : ' + r);
    await wait(1400);
  }
  await capture(cdp, step.name);
  if (step.esc) { await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true"); await wait(500); }
  if (step.back) { await cdp.eval(CLICK('Back')); await wait(900); }
  cdp.close();
}

fs.writeFileSync(path.join(OUTDIR, 'strings.json'), JSON.stringify({ screens, texts: [...all.keys()].sort(), textScreens: Object.fromEntries(all), attrs: [...attrsAll.keys()].sort(), attrScreens: Object.fromEntries(attrsAll) }, null, 2), 'utf8');
console.log('\n合计唯一文本 ' + all.size + ' 条，唯一属性 ' + attrsAll.size + ' 条 → ' + path.join(OUTDIR, 'strings.json'));
