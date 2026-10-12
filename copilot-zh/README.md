# GitHub Copilot 界面汉化（运行期注入）

把 GitHub Copilot 桌面应用（Tauri + WebView2）的界面变成中文。**不修改任何程序文件**，因此可逆、抗自动更新、随时能关。

## 原理

```
launch-copilot-zh.ps1
  ├─ 以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 启动 github.exe
  ├─ 等调试端口就绪
  └─ 常驻运行 inject.mjs ── CDP(WebSocket) ──> 应用 WebView2
        ├─ Runtime.evaluate           立即把当前界面翻成中文
        ├─ Page.addScriptToEvaluateOnNewDocument  刷新/重载后自动再生效
        ├─ Element.prototype.setAttribute 钩子     React 每次写回英文属性时当场替换
        ├─ MutationObserver（幂等重译）   文本节点与新增子树持续补翻，不做去重标记
        └─ 词典热重载                   改 dict.zh.json 后 3 秒内自动重刷
```

为什么这么做：应用的前端资源（HTML/JS）是**明文编译进 `github.exe`** 的，没有任何本地化资源、也没有语言设置
（`copilot config` 里不存在 locale 项，二进制里 `zh-CN` 出现 0 次）。直接在二进制里改字符串必须保持字节长度不变，
中文（UTF-8 每字 3 字节）几乎不可能塞进英文词槽，且会破坏签名与自动更新；运行期注入没有这些问题。

## 用法

```powershell
# 双击桌面快捷方式「GitHub Copilot 中文版」，或：
powershell -NoProfile -ExecutionPolicy Bypass -File launch-copilot-zh.ps1

# 强制重启一次（原生实例没有调试端口时必须）
powershell -File launch-copilot-zh.ps1 -Restart
```

脚本会复用已在运行的实例；如果发现应用在跑但没开调试端口，会自动重启一次（会话数据是持久化的，不会丢失）。

## 目录

| 文件 | 作用 |
| --- | --- |
| `launch-copilot-zh.ps1` | 启动器：开调试端口 + 常驻注入 + 跟随应用生命周期 |
| `inject.mjs` | 注入器：CDP 连接、词典下发、DOM 观察、热重载 |
| `dict.zh.json` | 汉化词典（**854 条精确词条 + 50 条正则规则**，含市场目录 198 条描述），改完 3 秒内热重载 |
| `lib/cdp.mjs` | 极简 CDP 客户端（Node 内置 WebSocket，无依赖） |
| `harvest.mjs` / `collect-all.mjs` / `harvest-missing.mjs` | 采集界面字符串、逐屏截图、找漏译 |
| `act.mjs` / `snap.mjs` | 点击、重载、截图的小工具 |
| `collect/`、`shots/` | 采集结果与截图 |

## 扩展词典

词典是普通 JSON：`text` 是精确匹配，`rules` 是正则（`$1` 引用捕获组）。改完保存即可——注入器会热重载并重刷当前界面。

```json
{
  "text": { "New": "新建" },
  "rules": [{ "pattern": "^Add server, (.+)$", "replace": "添加服务器：$1" }]
}
```

想找漏译：打开对应界面后运行 `node harvest-missing.mjs`，它只列出「仍是纯英文」的可见文本与属性。

## 覆盖范围与边界

- 已覆盖：首页、侧边栏、议题、拉取请求、自动化、命令面板、设置 **全部 11 个分区**（通用/账户/会话/主题/辅助功能/语音听写/计算机操作/定制/模型提供方/实验性/项目，含键盘快捷键对话框与全部快捷键条目）、定制页（浏览/已安装）、用户菜单、模式/模型/上下文菜单、会话配置、各类占位符与 tooltip。
- 市场目录：**198 条第三方 MCP 描述已全部翻译**（产品名保留原文）。
- **未翻译（刻意保留）**：约 60 个配色/主题名、第三方产品名（Figma、Jira、Power BI…）、单键名（A、Ctrl、F6…）、用户与仓库等动态数据（lsp725jk、C:\Users\y、v1.1.28）、代码样例（`const`/`function`、`// welcome`、`` `Hello, ${name}!` ``）——注入器主动跳过 `monaco-editor`、`contenteditable`、`code`/`pre` 内的文本。
- 与 `Issue`/`Pull Request` 相关的界面文案按 GitHub 中文惯例译为「议题 / 拉取请求」，若想保留英文，把 `dict.zh.json` 里对应的两条改回即可。
- 必须通过启动器启动才有效；原生快捷方式启动仍是英文。
- 应用更新后界面文本若变化，只影响未匹配到的句子，补词典即可，不用重新适配。
- 注入只是改显示文本，不改任何应用状态与设置。

## 已验证

- 逐状态普查：程序化走遍 **30+ 个界面状态**，收集所有非中文可见文本与属性，翻译后再复验，残留从 **576 条 → 5 条**，剩余全部是上述刻意保留项（`sweep*.json` 是原始采集数据）。
- 截图见 `shots/`：首页、设置页、定制目录页、已安装页。
- 重载页面后仍为中文（`zh-after-reload.png`），证明新文档注入生效。
- 词典热重载、React 重渲染补翻、属性写入钩子均已实测（`node harvest-missing.mjs` 可随时复查当前界面的漏译）。
