#!/usr/bin/env node
/**
 * dsh-mcp-server — 把 DeepSeek Harness (DSH) 接入 GitHub Copilot 的 MCP 桥
 *
 * 零依赖，stdio MCP 服务器（换行分隔的 JSON-RPC 2.0）。
 * 通过 DSH 的一次性任务模式 "dsh --profile headless --json" 把任务委派给 DSH 智能体，
 * 任务文本走 stdin（避免命令行转义问题），结果从 NDJSON 事件流里取 final 事件。
 *
 * 环境变量：
 *   DSH_CLI_EXE / DSH_CLI_ARGS  覆盖要启动的命令（JSON 数组），测试用
 *   DSH_INSTALL_ROOT            DSH 安装根目录，默认 %LOCALAPPDATA%\Programs\DeepSeek Harness
 *   DSH_MCP_TIMEOUT_MS          单次任务默认超时，默认 900000
 *   DSH_MCP_MAX_RESULT_CHARS    返回给模型的文本上限，默认 120000
 *   DSH_MCP_PROGRESS_MS         进度通知间隔，默认 15000
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'deepseek-harness';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_MCP_TIMEOUT_MS || 900000);
const MAX_TIMEOUT_MS = 3600000;
const MAX_RESULT_CHARS = Number(process.env.DSH_MCP_MAX_RESULT_CHARS || 120000);
const PROGRESS_MS = Number(process.env.DSH_MCP_PROGRESS_MS || 15000);
const STDERR_KEEP = 8000;

/** 默认档案：headless（一次性任务）。刻意不读 DSH_PROFILE —— DSH 桌面端会把它设成 desktop，
 *  而 desktop/web 档案由 Electron 应用独占，子进程拿来跑会被启动器拒绝。 */
function defaultProfile() {
  return process.env.DSH_MCP_PROFILE || 'headless';
}

// ---------------------------------------------------------------- 工作目录（MCP roots）

/** 客户端（Copilot）通过 MCP roots 告知的工作目录；MCP 服务进程自身的 cwd 往往是 ~/.copilot，不能当工作区用。 */
let clientRoots = [];
let rootsPromise = Promise.resolve();
let serverReqSeq = 1;
const pendingServerReqs = new Map();

function sendRequest(method, params, timeoutMs = 3000) {
  const id = 'srv-' + serverReqSeq++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingServerReqs.delete(id);
      log('客户端未在 ' + timeoutMs + 'ms 内回应 ' + method + '，忽略');
      resolve(null);
    }, timeoutMs);
    pendingServerReqs.set(id, (msg) => {
      clearTimeout(timer);
      pendingServerReqs.delete(id);
      resolve(msg);
    });
  });
}

async function refreshRoots() {
  const res = await sendRequest('roots/list', {});
  const roots = res && res.result && res.result.roots;
  if (!Array.isArray(roots)) return;
  const paths = [];
  for (const r of roots) {
    const uri = r && r.uri;
    if (!uri || typeof uri !== 'string') continue;
    try {
      paths.push(uri.startsWith('file:') ? fileURLToPath(uri) : uri);
    } catch {
      /* 非文件 URI 忽略 */
    }
  }
  if (paths.length) {
    clientRoots = paths;
    log('客户端工作目录:', clientRoots.join(' | '));
  }
}

/** 默认工作目录：显式入参 > DSH_MCP_DEFAULT_CWD > 客户端 roots > 服务进程 cwd */
function defaultCwd() {
  if (process.env.DSH_MCP_DEFAULT_CWD) return process.env.DSH_MCP_DEFAULT_CWD;
  if (clientRoots.length) return clientRoots[0];
  return process.cwd();
}

function log(...parts) {
  process.stderr.write('[dsh-mcp] ' + parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n');
}

// ---------------------------------------------------------------- CLI 解析

function dshRoot() {
  if (process.env.DSH_INSTALL_ROOT) return process.env.DSH_INSTALL_ROOT;
  const local = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  return local ? path.join(local, 'Programs', 'DeepSeek Harness') : '';
}

/** @returns {{kind:'exe'|'cmd', exe:string, args:string[], env:Record<string,string>, label:string}} */
export function resolveDshCli() {
  if (process.env.DSH_CLI_EXE) {
    let extra = [];
    if (process.env.DSH_CLI_ARGS) {
      try {
        const parsed = JSON.parse(process.env.DSH_CLI_ARGS);
        if (Array.isArray(parsed)) extra = parsed.map(String);
      } catch (err) {
        log('DSH_CLI_ARGS 不是合法 JSON 数组，已忽略：', String(err));
      }
    }
    return { kind: 'exe', exe: process.env.DSH_CLI_EXE, args: extra, env: {}, label: process.env.DSH_CLI_EXE };
  }
  const root = dshRoot();
  const exe = root ? path.join(root, 'DeepSeek Harness.exe') : '';
  const asar = root ? path.join(root, 'resources', 'app.asar') : '';
  // cli.js 位于 app.asar 内部，普通 fs 的 existsSync 看不到它，只能判断 exe 与 asar 本体。
  const cliJsInAsar = path.join(root || '', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  if (exe && asar && existsSync(exe) && existsSync(asar)) {
    // 与 dsh.cmd 等价，但不经过 cmd.exe：没有 shell 引号地狱，任务文本永远只走 stdin。
    return {
      kind: 'exe',
      exe,
      args: ['--expose-internals', cliJsInAsar],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: exe + ' (ELECTRON_RUN_AS_NODE + app.asar/dsh CLI)',
    };
  }
  const cmdPath = root ? path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') : '';
  if (cmdPath && existsSync(cmdPath)) {
    return { kind: 'cmd', exe: cmdPath, args: [], env: {}, label: cmdPath };
  }
  return { kind: 'cmd', exe: 'dsh', args: [], env: {}, label: 'dsh (PATH)' };
}

function shellQuote(s) {
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

function spawnDsh(appArgs, { cwd, env } = {}) {
  const cli = resolveDshCli();
  let exe;
  let args;
  let windowsVerbatimArguments = false;
  if (cli.kind === 'exe') {
    exe = cli.exe;
    args = [...cli.args, ...appArgs];
  } else {
    // 回退：cmd.exe /d /s /c ""<dsh.cmd>" <args>"（整条命令一次性交给 cmd）
    const comspec = process.env.ComSpec || 'cmd.exe';
    const head = cli.exe === 'dsh' ? 'dsh' : '"' + cli.exe + '"';
    exe = comspec;
    args = ['/d', '/s', '/c', '"' + head + ' ' + appArgs.map(shellQuote).join(' ') + '"'];
    windowsVerbatimArguments = true;
  }
  const child = spawn(exe, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...cli.env, ...(env || {}) },
    windowsHide: true,
    windowsVerbatimArguments,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, cli };
}

// ---------------------------------------------------------------- 任务执行

function emptyResult(extra) {
  return Object.assign(
    { exitCode: null, signal: null, finalText: '', errors: [], toolCalls: [], statuses: [], sessionId: '', rawLines: 0, stderr: '', timedOut: false, killed: false, ms: 0, launchError: '' },
    extra || {},
  );
}

/**
 * 运行一次 DSH 任务。任务文本经 stdin 传入。
 * @param {{task:string, cwd?:string, sessionId?:string, timeoutMs?:number, profile?:string, onProgress?:(info:object)=>void}} opts
 */
export function runDshTask(opts) {
  const task = String(opts.task ?? '');
  const profile = opts.profile || defaultProfile();
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const started = Date.now();
  const appArgs = ['--profile', profile, '--json'];
  if (opts.sessionId) appArgs.push('--session-id', String(opts.sessionId));

  return new Promise((resolve) => {
    let child;
    let cli;
    try {
      ({ child, cli } = spawnDsh(appArgs, { cwd: opts.cwd }));
    } catch (err) {
      resolve(emptyResult({ launchError: '无法启动 DSH：' + String(err && err.message ? err.message : err), ms: Date.now() - started }));
      return;
    }
    const res = emptyResult({ cli: cli.label, cwd: opts.cwd || process.cwd() });
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let timer = null;
    let ticker = null;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      res.ms = Date.now() - started;
      res.stderr = stderrBuf.slice(-STDERR_KEEP);
      Object.assign(res, extra || {});
      resolve(res);
    };

    const handleLine = (line) => {
      res.rawLines += 1;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return; // 非 JSON 行不该出现在 --json 模式，忽略
      }
      switch (evt.type) {
        case 'session':
          res.sessionId = String(evt.sessionId || evt.session || res.sessionId);
          break;
        case 'final':
          res.finalText = String(evt.text ?? '');
          break;
        case 'text':
          if (!res.finalText && evt.text) res.textFallback = (res.textFallback || '') + String(evt.text);
          break;
        case 'tool_call':
          res.toolCalls.push(String(evt.name || evt.tool || evt.toolName || 'tool'));
          break;
        case 'status':
          res.statuses.push(String(evt.status || evt.message || ''));
          break;
        case 'error':
          res.errors.push(String(evt.message || evt.error || 'unknown error'));
          break;
        default:
          break;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      if (stderrBuf.length > STDERR_KEEP * 4) stderrBuf = stderrBuf.slice(-STDERR_KEEP * 2);
    });

    child.on('error', (err) => finish({ launchError: '无法启动 DSH：' + String(err && err.message ? err.message : err) }));
    child.on('close', (code, signal) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      finish({ exitCode: code, signal });
    });

    try {
      child.stdin.on('error', () => {});
      child.stdin.end(task, 'utf8');
    } catch (err) {
      log('写入 stdin 失败：', String(err));
    }

    timer = setTimeout(() => {
      res.timedOut = true;
      try {
        child.kill();
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 3000);
    }, timeoutMs);

    if (typeof opts.onProgress === 'function' && PROGRESS_MS > 0) {
      ticker = setInterval(() => {
        try {
          opts.onProgress({ ms: Date.now() - started, toolCalls: res.toolCalls.length, sessionId: res.sessionId });
        } catch {}
      }, PROGRESS_MS);
    }
  });
}

export function formatTaskResult(res, opts = {}) {
  const secs = (res.ms / 1000).toFixed(1);
  const head = '【DeepSeek Harness / DSH】' + (res.exitCode === 0 && !res.timedOut && !res.launchError ? '任务完成' : '任务未正常完成');
  const meta = [
    '退出码=' + (res.exitCode === null ? 'n/a' : res.exitCode),
    '用时=' + secs + 's',
    res.cwd ? '工作目录=' + res.cwd : '',
    res.sessionId ? '会话=' + res.sessionId : '',
    res.toolCalls.length ? '工具调用=' + res.toolCalls.length + ' 次' : '',
  ].filter(Boolean).join('，');
  const body = res.finalText || res.textFallback || '';
  const parts = [head, meta, '', body ? '--- 最终答复 ---\n' + body : '(DSH 没有产出最终答复文本)'];

  if (res.launchError) parts.push('', '启动错误：' + res.launchError);
  if (res.timedOut) parts.push('', '超时：超过 ' + Math.round((opts.timeoutMs || 0) / 1000) + 's 已被终止；可以用更大的 timeout_ms 重试，或用 session_id 复用本次会话。');
  if (res.errors.length) parts.push('', '错误事件：\n' + res.errors.map((e) => '  - ' + e).join('\n'));
  if (res.exitCode !== 0 && !res.timedOut && res.stderr) parts.push('', 'DSH stderr（尾部）：\n' + res.stderr.slice(-2000));
  if (opts.includeTrace && res.toolCalls.length) parts.push('', '工具调用序列：\n' + res.toolCalls.map((t, i) => '  ' + (i + 1) + '. ' + t).join('\n'));

  let out = parts.join('\n');
  if (out.length > MAX_RESULT_CHARS) out = out.slice(0, MAX_RESULT_CHARS) + '\n…（已截断，原始长度 ' + out.length + ' 字符）';
  return out;
}

function probeVersion() {
  return new Promise((resolve) => {
    let child;
    try {
      ({ child } = spawnDsh(['--version']));
    } catch (err) {
      resolve('');
      return;
    }
    let out = '';
    const done = (v) => resolve(v);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => done(''));
    child.on('close', () => done(out.trim().split('\n')[0] || ''));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done(out.trim().split('\n')[0] || '');
    }, 20000);
  });
}

async function dshInfoText() {
  const cli = resolveDshCli();
  const dshHome = process.env.DSH_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : '');
  let profiles = [];
  try {
    profiles = readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {}
  const version = await probeVersion();
  return [
    'DSH 接入信息',
    '  CLI:        ' + cli.label,
    '  版本:       ' + (version || '(未取到)'),
    '  DSH_HOME:   ' + (dshHome || '(未设置)') + (existsSync(dshHome) ? '' : '  ← 不存在'),
    '  可用档案:   ' + (profiles.length ? profiles.join(', ') : '(无)'),
    '  默认档案:   ' + defaultProfile() + (process.env.DSH_PROFILE && process.env.DSH_PROFILE !== defaultProfile() ? '（已忽略继承来的 DSH_PROFILE=' + process.env.DSH_PROFILE + '）' : ''),
    '  默认工作目录: ' + defaultCwd() + (clientRoots.length ? '（来自 MCP roots）' : '（客户端未提供 roots，退回服务进程 cwd）'),
    '  服务进程 cwd: ' + process.cwd(),
    '',
    '用 dsh_run 委派任务；省略 cwd 时在该服务进程的当前目录（通常是 Copilot 的工作区）运行。',
  ].join('\n');
}

// ---------------------------------------------------------------- MCP 工具表

const TOOLS = [
  {
    name: 'dsh_run',
    description:
      '把一项任务委派给 DeepSeek Harness（DSH）智能体执行，并返回它的最终答复。DSH 是一个独立、能力完整的编码智能体，拥有自己的模型、技能与 MCP 工具；本调用是一次性任务（跑完即退出）。' +
      '适合：多步骤的实现/重构/调研、需要长时间运行的批量工作、需要 DSH 生态（技能、插件、MCP 挂载）的任务，或用户明确要求"让 DSH 来做"。' +
      'DSH 会在指定工作目录里用自身权限实际修改文件、执行命令，因此要么在用户已授权的工作区内使用，要么先向用户确认。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: '交给 DSH 的完整任务描述，自包含、写清目标与验收标准（它会独立开工，看不到本次对话）。' },
        cwd: { type: 'string', description: 'DSH 的工作目录（绝对路径）。省略时用当前工作区。' },
        session_id: { type: 'string', description: '沿用之前 dsh_run 返回的 DSH 会话 id，继续同一段对话（cwd 必须与那次一致）。' },
        timeout_ms: { type: 'integer', description: '超时毫秒数，默认 900000（15 分钟），上限 3600000。' },
        profile: { type: 'string', description: '要启动的 DSH 档案，默认 headless（一次性任务）。一般不用改：desktop / web 由 DSH 桌面端独占。' },
        include_trace: { type: 'boolean', description: '是否附上 DSH 的工具调用序列，默认 false。' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_info',
    description: '查看 DSH 接入状态：CLI 路径、版本、DSH_HOME、可用档案与默认档案。接入异常时先用它排查。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

async function callTool(name, args, progress) {
  if (name === 'dsh_info') {
    return { text: await dshInfoText(), isError: false };
  }
  if (name === 'dsh_run') {
    const task = String(args.task ?? '').trim();
    if (!task) return { text: 'dsh_run 需要一个非空 task。', isError: true };
    await rootsPromise;
    const cwd = args.cwd ? String(args.cwd) : defaultCwd();
    if (args.cwd && !existsSync(cwd)) return { text: 'cwd 不存在：' + cwd, isError: true };
    const res = await runDshTask({
      task,
      cwd,
      sessionId: args.session_id ? String(args.session_id) : '',
      profile: args.profile ? String(args.profile) : '',
      timeoutMs: args.timeout_ms,
      onProgress: progress,
    });
    const effectiveTimeout = Math.min(Math.max(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const text = formatTaskResult(res, { includeTrace: !!args.include_trace, timeoutMs: effectiveTimeout });
    const ok = res.exitCode === 0 && !res.timedOut && !res.launchError;
    return { text, isError: !ok };
  }
  return null;
}

// ---------------------------------------------------------------- MCP 传输

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const INSTRUCTIONS =
  '这里挂着 DeepSeek Harness（DSH）智能体。需要把较重、多步骤或需要长时间运行的工作外包出去时，用 dsh_run 把任务整体交给 DSH，' +
  '它会独立完成并返回最终答复；同一段工作可以用返回的 session_id 继续。';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) void handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    sendError(null, -32700, 'JSON 解析失败');
    return;
  }
  const { id, method, params } = msg;
  if (method === undefined) {
    const handler = pendingServerReqs.get(String(id));
    if (handler) handler(msg); // 我们主动发出请求（roots/list）的回包
    return;
  }
  if (id === undefined || id === null) {
    // 通知类消息
    if (method === 'notifications/cancelled') log('收到取消通知', params && params.requestId);
    if (method === 'notifications/roots/list_changed') rootsPromise = refreshRoots();
    return;
  }
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      sendResult(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
      // 客户端声明支持 roots 时，主动问一次工作目录（MCP 服务进程自身的 cwd 通常是 ~/.copilot）
      if (params && params.capabilities && params.capabilities.roots) rootsPromise = refreshRoots();
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const progressToken = params && params._meta && params._meta.progressToken;
      let progress;
      if (progressToken !== undefined && progressToken !== null) {
        progress = (info) => {
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: info.toolCalls, total: undefined, message: 'DSH 运行中 ' + Math.round(info.ms / 1000) + 's，已调用 ' + info.toolCalls + ' 个工具' },
          });
        };
        progress({ ms: 0, toolCalls: 0 });
      }
      try {
        const out = await callTool(String(name), args, progress);
        if (!out) {
          sendError(id, -32602, '未知工具：' + String(name));
          return;
        }
        sendResult(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError });
      } catch (err) {
        sendResult(id, { content: [{ type: 'text', text: 'dsh 桥内部错误：' + String(err && err.stack ? err.stack : err) }], isError: true });
      }
      return;
    }
    case 'resources/list':
      sendResult(id, { resources: [] });
      return;
    case 'resources/templates/list':
      sendResult(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;
    case 'logging/setLevel':
      sendResult(id, {});
      return;
    default:
      sendError(id, -32601, '不支持的方法：' + method);
  }
}

log('ready', { pid: process.pid, cwd: process.cwd(), cli: resolveDshCli().label });
