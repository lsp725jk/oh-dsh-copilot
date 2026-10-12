// 极简 CDP 客户端（Node 内置 WebSocket / fetch，无依赖）
export async function listTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  return await res.json();
}

export class Cdp {
  static async connect(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('WebSocket 错误: ' + (e.message || 'unknown'))); }, { once: true });
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message + ' (' + msg.error.code + ')')) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
        for (const fn of this.listeners.get('*') || []) fn(msg);
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 调用超时: ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
