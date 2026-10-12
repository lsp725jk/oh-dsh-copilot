#!/usr/bin/env node
/**
 * stub-dsh — 测试用的假 DSH CLI。
 * 模拟 "dsh --profile headless --json" 的行为：stdin 收任务，stdout 出 NDJSON 事件。
 *   STUB_FAIL=1      以失败收场（error 事件 + 退出码 1）
 *   STUB_DELAY_MS=n  在 final 之前停顿 n 毫秒（测进度通知/超时）
 *   STUB_NO_FINAL=1  不发 final 事件（只有 text）
 */
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write('0.2.0-rc.2-stub\n');
  process.exit(0);
}
const sessionFlag = args.indexOf('--session-id');
const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : 'session-stub-' + process.pid;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (task += c));
process.stdin.on('end', async () => {
  emit({ type: 'session', sessionId });
  emit({ type: 'status', status: 'running' });
  emit({ type: 'tool_call', name: 'read_file', args: { path: 'x' } });
  const delay = Number(process.env.STUB_DELAY_MS || 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (process.env.STUB_FAIL === '1') {
    emit({ type: 'error', message: 'stub 故意失败' });
    process.stderr.write('dsh: stub-failure: boom\n');
    process.exit(1);
  }
  const answer = 'STUB_ANSWER::' + task.trim();
  emit({ type: 'text', text: answer });
  if (process.env.STUB_NO_FINAL !== '1') emit({ type: 'final', text: answer });
  process.exit(0);
});
