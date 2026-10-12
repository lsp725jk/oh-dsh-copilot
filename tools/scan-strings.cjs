// 流式扫描二进制里的 ASCII/UTF-8 标记，用于判断前端资源是否以明文嵌在 exe 里。
// 用法: node scan-strings.cjs <file> <pattern> [pattern...]
const fs = require('fs');
const file = process.argv[2];
const patterns = process.argv.slice(3).map((p) => Buffer.from(p, 'utf8'));
const size = fs.statSync(file).size;
const fd = fs.openSync(file, 'r');
const CHUNK = 1 << 22;
const overlap = Math.max(...patterns.map((p) => p.length)) - 1;
let carry = Buffer.alloc(0);
let offset = 0;
const hits = new Map(patterns.map((p) => [p.toString('utf8'), 0]));
const firstHit = new Map();
let buf = Buffer.alloc(CHUNK);
while (offset < size) {
  const read = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
  if (read <= 0) break;
  const chunk = Buffer.concat([carry, buf.subarray(0, read)]);
  for (const p of patterns) {
    let idx = chunk.indexOf(p);
    while (idx >= 0) {
      const key = p.toString('utf8');
      hits.set(key, hits.get(key) + 1);
      if (!firstHit.has(key)) firstHit.set(key, offset - carry.length + idx);
      idx = chunk.indexOf(p, idx + 1);
    }
  }
  carry = chunk.subarray(Math.max(0, chunk.length - overlap));
  offset += read;
}
fs.closeSync(fd);
for (const [k, v] of hits) console.log(v + '\t' + (firstHit.has(k) ? 'first@0x' + firstHit.get(k).toString(16) : '-') + '\t' + k);
