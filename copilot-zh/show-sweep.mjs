import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const kind = process.argv[3];
const from = Number(process.argv[4] || 0);
const to = Number(process.argv[5] || 9999);
const list = kind === 'attrs' ? d.attrs : d.texts;
const states = kind === 'attrs' ? d.attrStates : d.textStates;
console.log(kind + ' total=' + list.length);
for (let i = from; i < Math.min(to, list.length); i += 1) {
  console.log(String(i).padStart(3) + '|' + list[i] + '  ~' + (states[list[i]] || []).join(','));
}
