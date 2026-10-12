// Minimal Electron asar reader (pickle-in-pickle header). Usage:
//   node dsh-asar.cjs <asar> list [substring]
//   node dsh-asar.cjs <asar> read <innerPath>
const fs = require('fs');
const asarPath = process.argv[2];
const mode = process.argv[3];
const target = process.argv[4] || '';
const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonSize = head.readUInt32LE(12);
const dataOffset = 16 + jsonSize + ((4 - (jsonSize % 4)) % 4);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (entry.files) walk(entry, p);
    else files.push({ path: p.slice(1), size: entry.size, offset: Number(entry.offset) });
  }
})(header, '');
if (mode === 'list') {
  const hits = target ? files.filter((f) => f.path.includes(target)) : files;
  process.stdout.write(hits.slice(0, 300).map((f) => f.size + '  ' + f.path).join('\n') + '\nMATCHED ' + hits.length + ' / ' + files.length + '\n');
} else {
  const f = files.find((x) => x.path === target);
  if (!f) { process.stderr.write('not found: ' + target + '\n'); process.exit(2); }
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, dataOffset + f.offset);
  process.stdout.write(buf);
}
