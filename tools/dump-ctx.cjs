// 从二进制里按偏移抽取上下文: node dump-ctx.cjs <file> <offsetHex> [bytes]
const fs = require('fs');
const file = process.argv[2];
const off = parseInt(process.argv[3], 16);
const len = Number(process.argv[4] || 1500);
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(len);
fs.readSync(fd, buf, 0, len, off);
fs.closeSync(fd);
process.stdout.write(buf.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '.') + '\n');
