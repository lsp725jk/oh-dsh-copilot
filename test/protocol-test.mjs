#!/usr/bin/env node
/**
 * protocol-test — 不依赖 Copilot、也不依赖真实 DSH 的桥自检。
 * 用 stub-dsh 当假 CLI，逐条验证 MCP 协议行为与事件解析。
 *   node test/protocol-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp', 'dsh-mcp-server.mjs');
const STUB = path.join(here, 'stub-dsh.mjs');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

class Client {
  constructor(env) {
    this.lines = [];
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = [];
    this.roots = env && env.ROOTS_URI ? [{ uri: env.ROOTS_URI }] : [];
    this.notifications = [];
    this.serverStderr = '';
    this.proc = spawn(NODE, [SERVER], {
      env: { ...process.env, DSH_CLI_EXE: NODE, DSH_CLI_ARGS: JSON.stringify([STUB]), DSH_MCP_PROGRESS_MS: '400', ...env },
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
        if (line) this.onLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => (this.serverStderr += c));
  }
  onLine(line) {
    this.lines.push(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.badLine = line;
      return;
    }
    // 服务端主动请求（roots/list）→ 按 MCP 约定回包
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this.serverRequests.push(msg);
      if (msg.method === 'roots/list') {
        const nl = String.fromCharCode(10);
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { roots: this.roots } }) + nl);
      }
      return;
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
  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('超时：' + method)), 60000);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  close() {
    this.proc.stdin.end();
    return new Promise((r) => this.proc.on('close', r));
  }
}

const main = async () => {
  console.log('== 1. 握手与工具表 ==');
  const c = new Client({ ROOTS_URI: 'file:///E:/Hanako/OH-WorkSpace' });
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'protocol-test', version: '1' }, ROOTS_URI_SENTINEL: undefined });
  check('initialize 返回 serverInfo.name', init.result?.serverInfo?.name === 'deepseek-harness', JSON.stringify(init.result?.serverInfo));
  check('initialize 回显协议版本', init.result?.protocolVersion === '2025-06-18', String(init.result?.protocolVersion));
  check('声明 tools 能力', !!init.result?.capabilities?.tools);
  check('带 instructions', typeof init.result?.instructions === 'string' && init.result.instructions.length > 0);
  c.notify('notifications/initialized', {});

  const list = await c.request('tools/list', {});
  const tools = list.result?.tools || [];
  check('tools/list 返回 2 个工具', tools.length === 2, tools.map((t) => t.name).join(','));
  const run = tools.find((t) => t.name === 'dsh_run');
  check('dsh_run 有 JSON Schema 且必填 task', run?.inputSchema?.required?.includes('task'));
  check('dsh_run 描述非空', typeof run?.description === 'string' && run.description.length > 20);

  console.log('== 2. MCP roots（工作目录）==');
  const infoEarly = await c.request('tools/call', { name: 'dsh_info', arguments: {} });
  const earlyText = infoEarly.result?.content?.[0]?.text || '';
  check('服务端主动请求了 roots/list', c.serverRequests.some((r) => r.method === 'roots/list'), JSON.stringify(c.serverRequests.map((r) => r.method)));
  check('dsh_info 采用客户端 roots 作为默认工作目录', earlyText.includes('E:\\Hanako\\OH-WorkSpace'), earlyText.slice(0, 400));

  console.log('== 2b. dsh_info ==');
  const info = await c.request('tools/call', { name: 'dsh_info', arguments: {} });
  const infoText = info.result?.content?.[0]?.text || '';
  check('dsh_info 正常返回', info.result?.isError === false);
  check('dsh_info 含 DSH_HOME', infoText.includes('DSH_HOME'), infoText.slice(0, 200));
  check('dsh_info 取到 stub 版本', infoText.includes('0.2.0-rc.2-stub'), infoText.slice(0, 300));

  console.log('== 3. dsh_run（stub 成功路径）==');
  const r1 = await c.request('tools/call', { name: 'dsh_run', arguments: { task: '把 1+1 的结果告诉我' } });
  const t1 = r1.result?.content?.[0]?.text || '';
  check('dsh_run 成功', r1.result?.isError === false);
  check('带出 final 文本', t1.includes('STUB_ANSWER::把 1+1 的结果告诉我'), t1.slice(0, 300));
  check('报告会话 id', /session-stub-\d+/.test(t1), t1.slice(0, 200));
  check('报告工具调用次数', t1.includes('工具调用=1 次'), t1.slice(0, 300));
  check('报告实际工作目录', t1.includes('工作目录=E:\\Hanako\\OH-WorkSpace'), t1.slice(0, 300));
  check('未要求时不带工具序列', !t1.includes('工具调用序列'));

  const r2 = await c.request('tools/call', { name: 'dsh_run', arguments: { task: '再来一次', include_trace: true, session_id: 'session-keep-1' } });
  const t2 = r2.result?.content?.[0]?.text || '';
  check('include_trace 生效', t2.includes('工具调用序列') && t2.includes('read_file'), t2.slice(0, 400));
  check('session_id 透传（stub 回显）', t2.includes('session-keep-1'), t2.slice(0, 200));

  console.log('== 4. 错误路径 ==');
  const missing = await c.request('tools/call', { name: 'dsh_run', arguments: {} });
  check('空 task 被拒', missing.result?.isError === true && /非空 task/.test(missing.result.content[0].text));
  const badCwd = await c.request('tools/call', { name: 'dsh_run', arguments: { task: 'x', cwd: 'Z:\\does\\not\\exist' } });
  check('不存在的 cwd 被拒', badCwd.result?.isError === true && /cwd 不存在/.test(badCwd.result.content[0].text));
  const unknown = await c.request('tools/call', { name: 'nope', arguments: {} });
  check('未知工具返回 -32602', unknown.error?.code === -32602, JSON.stringify(unknown.error));
  const unknownMethod = await c.request('resources/read', { uri: 'x' });
  check('未知方法返回 -32601', unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error));
  const empty = await c.request('prompts/list', {});
  check('prompts/list 返回空表', Array.isArray(empty.result?.prompts));

  console.log('== 5. 失败任务与进度通知 ==');
  const c2 = new Client({ STUB_FAIL: '1' });
  await c2.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const rf = await c2.request('tools/call', { name: 'dsh_run', arguments: { task: '会失败的任务' } });
  const tf = rf.result?.content?.[0]?.text || '';
  check('失败任务标记 isError', rf.result?.isError === true);
  check('失败任务带出错误事件', tf.includes('stub 故意失败'), tf.slice(0, 300));
  check('失败任务带出退出码', /退出码=1/.test(tf), tf.slice(0, 200));
  await c2.close();

  const c3 = new Client({ STUB_DELAY_MS: '1500' });
  await c3.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const rp = await c3.request('tools/call', { name: 'dsh_run', arguments: { task: '慢任务', _meta: { progressToken: 'tok-1' } } });
  // 正确位置是 params._meta，这里同时测一次
  const rp2 = await c3.request('tools/call', { name: 'dsh_run', arguments: { task: '慢任务2' }, _meta: { progressToken: 'tok-2' } });
  const progress = c3.notifications.filter((n) => n.method === 'notifications/progress');
  check('带 progressToken 时发出进度通知', progress.length >= 2, 'notifications=' + progress.length);
  check('进度通知带 message', typeof progress[0]?.params?.message === 'string', JSON.stringify(progress[0] || {}));
  check('慢任务仍成功', rp.result?.isError === false && rp2.result?.isError === false);
  await c3.close();

  console.log('== 6. 协议卫生 ==');
  check('stdout 全部是合法 JSON-RPC 行', !c.badLine, c.badLine);
  check('无 Content-Length 之类的脏输出', c.lines.every((l) => l.trim().startsWith('{')), c.lines.find((l) => !l.trim().startsWith('{')) || '');
  check('诊断只走 stderr', c.serverStderr.includes('[dsh-mcp]'), c.serverStderr.slice(0, 120));
  await c.close();

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failures.length) {
    console.log('失败明细：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(2);
});
