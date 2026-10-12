#!/usr/bin/env node
/**
 * live-test — 用真实 DSH 跑一遍桥（会消耗一次 DSH 模型调用）。
 *   node test/live-test.mjs
 * 环境变量：
 *   LIVE_TIMEOUT_MS  单次任务超时，默认 300000
 *   LIVE_RESUME=1    额外验证 session_id 续跑
 *   LIVE_TASK        自定义任务文本
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp', 'dsh-mcp-server.mjs');
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 300000);
const TASK = process.env.LIVE_TASK || '只回复一行字：DSH 桥接成功。不要调用任何工具，不要读写任何文件。';

class Client {
  constructor(env) {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.badLine = '';
    this.proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.badLine = line;
          continue;
        }
        if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p(msg);
          }
        } else if (msg.method) {
          this.notifications.push(msg);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => (this.stderr += c));
  }
  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('客户端等待超时：' + method)), timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
  close() {
    this.proc.stdin.end();
    return new Promise((r) => this.proc.on('close', r));
  }
}

const call = async (c, name, args) => c.request('tools/call', { name, arguments: args }, TIMEOUT_MS + 120000);

const main = async () => {
  const c = new Client();
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '1' } });
  console.log('serverInfo:', JSON.stringify(init.result?.serverInfo));
  console.log('服务端解析到的 CLI:', c.stderr.match(/\[dsh-mcp\] ready .*/)?.[0] || '(无)');

  console.log('\n--- dsh_info ---');
  const startedInfo = Date.now();
  const info = await call(c, 'dsh_info', {});
  console.log(info.result?.content?.[0]?.text || JSON.stringify(info));
  console.log('（' + ((Date.now() - startedInfo) / 1000).toFixed(1) + 's）');

  console.log('\n--- dsh_run（真实 DSH 一次性任务）---');
  console.log('任务：' + TASK);
  const t0 = Date.now();
  const run = await call(c, 'dsh_run', { task: TASK, timeout_ms: TIMEOUT_MS });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const text = run.result?.content?.[0]?.text || '';
  console.log('isError=' + run.result?.isError + '，用时 ' + elapsed + 's');
  console.log(text.slice(0, 2000));
  const sessionId = (text.match(/会话=(session-[^\s，]+)/) || [])[1] || '';
  console.log('解析出的会话 id：' + (sessionId || '(无)'));

  let resumeOk = true;
  if (process.env.LIVE_RESUME === '1' && run.result?.isError === false && sessionId) {
    console.log('\n--- dsh_run（session_id 续跑）---');
    const t1 = Date.now();
    const r2 = await call(c, 'dsh_run', { task: '再回复一行字：第二次也成功。不要调用任何工具。', session_id: sessionId, timeout_ms: TIMEOUT_MS });
    const t2 = r2.result?.content?.[0]?.text || '';
    console.log('isError=' + r2.result?.isError + '，用时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
    console.log(t2.slice(0, 1200));
    resumeOk = r2.result?.isError === false && t2.includes(sessionId);
  }

  console.log('\nstdout 是否有非法行：' + (c.badLine || '无'));
  await c.close();
  const ok = run.result?.isError === false && !c.badLine && resumeOk;
  console.log(ok ? '\nLIVE TEST: PASS' : '\nLIVE TEST: FAIL');
  process.exit(ok ? 0 : 1);
};

main().catch((err) => {
  console.error('live-test 崩溃：', err);
  process.exit(2);
});
