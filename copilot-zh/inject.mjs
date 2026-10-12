// GitHub Copilot 桌面应用汉化注入器
// 通过 WebView2 的远程调试通道（CDP）把中文词典打进界面，不修改任何程序文件。
// 用法:
//   node inject.mjs [--port 9333] [--dict dict.zh.json] [--once]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTargets, Cdp } from './lib/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const PORT = Number(arg('port', 9333));
const DICT_PATH = path.resolve(here, arg('dict', 'dict.zh.json'));
const ONCE = argv.includes('--once');

let dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
let dictMtime = fs.statSync(DICT_PATH).mtimeMs;
const RUNTIME_REV = 3; // 改注入器运行时代码时 +1，强制页面重装新代码
const dictRev = (d) => 'r' + RUNTIME_REV + '-v' + d.version + '-' + Object.keys(d.text).length + '-' + (d.rules || []).length;
function reloadDictIfChanged() {
  const m = fs.statSync(DICT_PATH).mtimeMs;
  if (m === dictMtime) return false;
  dictMtime = m;
  dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
  console.log('[zh] 词典已热重载 ' + dictRev(dict) + '（' + Object.keys(dict.text).length + ' 条）');
  return true;
}

/** 页面内运行的翻译运行时（自包含，可重复注入） */
function pageRuntime(dictData) {
  const payload = JSON.stringify({ ...dictData, rev: dictRev(dictData) });
  return String.raw`(() => {
  const D = ${payload};
  if (window.__copilotZh && window.__copilotZh.rev === D.rev) { window.__copilotZh.rescan(); return window.__copilotZh.count; }
  if (window.__copilotZh && window.__copilotZh.dispose) window.__copilotZh.dispose();
  const RULES = (D.rules || []).map((r) => ({ re: new RegExp(r.pattern), rep: r.replace }));
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'SVG', 'CANVAS', 'INPUT', 'OPTION']);
  let count = 0;

  const translate = (raw) => {
    if (!raw) return null;
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 400 || !/[A-Za-z]/.test(t)) return null;
    if (Object.prototype.hasOwnProperty.call(D.text, t)) return D.text[t];
    for (const r of RULES) {
      const m = t.match(r.re);
      if (!m) continue;
      // 捕获组先各自过一遍词典，再代入替换模板（$1 → 组内容）
      let out = r.rep;
      for (let i = 1; i < m.length; i += 1) {
        const g = m[i] === undefined ? '' : m[i];
        const gz = Object.prototype.hasOwnProperty.call(D.text, g) ? D.text[g] : g;
        out = out.split('$' + i).join(gz);
      }
      if (out !== t) return out;
    }
    return null;
  };

  const skip = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[data-zh-ignore]')) return true;
    if (el.closest('.monaco-editor')) return true;
    if (el.isContentEditable) return true;
    let p = el;
    for (let i = 0; i < 3 && p; i += 1, p = p.parentElement) if (SKIP_TAGS.has(p.tagName)) return true;
    return false;
  };

  // 幂等：已经翻好的中文不会再命中词典，因此重复调用是安全的，不需要"自我改动"标记
  const doText = (node) => {
    const el = node.parentElement;
    if (skip(el)) return;
    const zh = translate(node.nodeValue);
    if (zh && zh !== node.nodeValue) {
      node.nodeValue = zh;
      count += 1;
    }
  };

  const doAttrs = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (el.closest('[data-zh-ignore]')) return; // 属性属于界面文本，编辑器/输入框内也照翻
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const zh = translate(v);
      if (zh && zh !== v) { el.setAttribute(a, zh); count += 1; }
    }
  };

  const walk = (rootNode) => {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { doText(rootNode); return; }
    if (rootNode.nodeType !== 1) return;
    if (rootNode.hasAttribute && Object.keys(ATTRS).length) doAttrs(rootNode);
    const w = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = w.nextNode();
    while (n) { if (n.nodeType === 3) doText(n); else if (n.nodeType === 1) doAttrs(n); n = w.nextNode(); }
  };

  // 钩住属性写入：React 每次重渲染都会写回英文，这里在写入瞬间就换成中文，
  // 比"事后观察 + 回填"稳得多（placeholder / aria-label / title 都走 setAttribute）。
  if (!Element.prototype.__dshZhPatched) {
    const ATTR_SET = new Set(ATTRS);
    const origSetAttribute = Element.prototype.setAttribute;
    const patched = function (name, value) {
      if (ATTR_SET.has(name) && typeof value === 'string') {
        const zh = translate(value);
        if (zh && zh !== value) {
          count += 1;
          return origSetAttribute.call(this, name, zh);
        }
      }
      return origSetAttribute.call(this, name, value);
    };
    patched.__dshZhPatched = true;
    Element.prototype.setAttribute = patched;
    Element.prototype.__dshZhPatched = true;
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else if (m.type === 'childList') { for (const n of m.addedNodes) walk(n); }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  const rescan = () => { count = 0; walk(document.body); return count; };
  document.documentElement.lang = 'zh-CN';
  rescan();
  window.__copilotZh = { rev: D.rev, version: D.version, rescan, dispose: () => observer.disconnect(), get count() { return count; }, translate };
  return count;
})()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attached = new Map(); // wsUrl -> cdp
let totalTicks = 0;

async function attach(wsUrl) {
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageRuntime(dict) });
  const applied = await cdp.eval(pageRuntime(dict));
  cdp.on('*', (msg) => {
    if (msg.method === 'Page.frameNavigated' && msg.params && msg.params.frame && !msg.params.frame.parentId) {
      setTimeout(() => { cdp.eval(pageRuntime(dict)).catch(() => {}); }, 600);
    }
  });
  cdp.ws.addEventListener('close', () => { attached.delete(wsUrl); console.log('[zh] 连接关闭，等待重连: ' + wsUrl.slice(-24)); });
  attached.set(wsUrl, cdp);
  console.log('[zh] 已注入 ' + wsUrl.slice(-24) + ' → 本次替换 ' + applied + ' 处');
  return applied;
}

async function tick() {
  totalTicks += 1;
  let targets = [];
  if (reloadDictIfChanged()) {
    for (const [url, cdp] of [...attached]) {
      try {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageRuntime(dict) });
        const n = await cdp.eval(pageRuntime(dict));
        console.log('[zh] 已用新词典重刷 ' + url.slice(-24) + ' → 新增替换 ' + n + ' 处');
      } catch { attached.delete(url); }
    }
  }
  try { targets = await listTargets(PORT); } catch (err) {
    if (totalTicks % 10 === 1) console.log('[zh] 等待 Copilot 调试端口 ' + PORT + ' …');
    return;
  }
  for (const t of targets) {
    if (t.type !== 'page' || !t.webSocketDebuggerUrl) continue;
    if (attached.has(t.webSocketDebuggerUrl)) continue;
    try { await attach(t.webSocketDebuggerUrl); } catch (err) { console.log('[zh] 注入失败: ' + (err && err.message)); }
  }
  // 保活：给已有连接重新执行一次（React 会把部分文本改回英文，观察器通常已处理，这里兜底）
  for (const [url, cdp] of [...attached]) {
    try { await cdp.eval('window.__copilotZh && window.__copilotZh.rescan && window.__copilotZh.rescan()'); }
    catch { attached.delete(url); }
  }
}

await tick();
if (ONCE) {
  for (const cdp of attached.values()) cdp.close();
  console.log('[zh] --once 模式，退出');
  process.exit(0);
}
console.log('[zh] 汉化已启用（常驻）——词典 v' + dict.version + '，条目 ' + Object.keys(dict.text).length + '，规则 ' + (dict.rules || []).length);
setInterval(() => { tick().catch(() => {}); }, 3000);
