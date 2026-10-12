import fs from 'node:fs';
const themes = new Set(['A cup of coffee','ABOLKOG','Aurora','Ayu','Base16 Flat','Base16 Mocha','Blue Dolphin','Calm Days, Sober Nights Sky','Catppuccin Frappé','Catppuccin Macchiato','Catppuccin Mocha','Chai','Chinolor','Cyberdyne','Desert','Django Reborn Again','Espresso','EyeHealth','Flexoki','Fox','Garbage Oracle','GitHub','Gruvbox Material','Homebrew','IC Orange PPL','IKKI','Kanso Ink','Kary Pro Colors','Light purple','Mondrian','Monochrome','Monochrome Stone','Monokai Pro Spectrum','Monospace','Noctis Azureus','Noctis Hibernus','Noir Essence','Nord Midnight','Notionish','Phonebook','Polychrome','Purplepeter','Rainglow Codecourse','Rainglow Crisp','Rainglow Lavender','Remedy Tilted','Rosé Pine','Selene Selenized','Shades of Purple','Soft Color','Tearout','Tokyo Night','Tomorrow Night Eighties','Vaporizer Turquoise','Xotopio','Yuttari','Zenbones Rosebones',"Zhxo'red"]);
const keep = (s) => {
  if (themes.has(s)) return true;
  if (/^[A-Za-z]$/.test(s)) return true;                                  // 单键
  if (/^(Alt|Ctrl|Shift|Ctrl \+ .+|Shift \+ Tab|F\d+|Ctrl\+K|Question mark)$/.test(s)) return true;
  if (/^[\d.,]+k?$/.test(s)) return true;                                  // 星标数
  if (/^(v?\d+\.\d+\.\d+|\d+%|@?lsp725jk|lsp725jk-my-feature|github\.com|C:\\Users\\y|~\\copilot-worktrees.*|nemotron-.*|skills\/dsh|dsh|dsh-delegation|af|latex|plugins|extensions|agent-merge|agentfinder|create-canvas|orchestrate|pr-stack|MCP|SCORE|\.FAF Context|1\.9k)$/.test(s)) return true;
  if (/^(const|function|return|name|greet|msg|action|Hi,|%username%|\/permissions|\/\/ welcome|Co-authored-by|`Hello.*)$/.test(s)) return true;
  if (/^(Azure|Azure DevOps|Figma|Jira|Playwright|Power BI|Sentry|WorkIQ|Microsoft Foundry|Zapier|Zereight Gitlab|Zscaler Zero Trust Exchange|Web Design Guidelines|Grill Me by Matt Pocock|Impeccable Design|Ads MCP|Agent Radar|Agent Ready|Agentic HIL|Alterlab|AlvisoOculus Optionsahoy|Amplitude|Anima MCP Server|Ansvar: EU Compliance & Legal Intelligence|Apify|Argus Testing — Autonomous QA MCP|Arm MCP Server|Atlassian Rovo MCP Server|Atom\.com — Premium Domains|Browser|HydraFusion)$/.test(s)) return true;
  if (s.startsWith('MCP Servers · ')) return false;                       // 目录描述应已汉化
  return false;
};
const out = [];
for (const f of ['sweep-v10-1.json', 'sweep-v10-2.json']) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const t of [...d.texts, ...d.attrs]) if (!keep(t)) out.push(t);
}
const uniq = [...new Set(out)];
console.log('需要人工确认的残留 ' + uniq.length + ' 条：');
for (const s of uniq) console.log('  - ' + (s.length > 120 ? s.slice(0, 120) + '…' : s));