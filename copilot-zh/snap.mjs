// 截取 Copilot 界面截图: node snap.mjs <port> <out.png>
import fs from 'node:fs';
import { listTargets, Cdp } from './lib/cdp.mjs';
const PORT = Number(process.argv[2] || 9333);
const OUT = process.argv[3] || 'shot.png';
const targets = await listTargets(PORT);
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('没有 page 目标'); process.exit(1); }
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('已保存 ' + OUT);
cdp.close();
