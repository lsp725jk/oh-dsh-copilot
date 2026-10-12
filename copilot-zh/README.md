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
        ├─ MutationObserver            React 重渲染、切换页面后自动补翻
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
| `dict.zh.json` | 汉化词典（约 300 条精确词条 + 17 条正则规则），改完自动生效 |
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

- 已覆盖：首页、侧边栏、自动化、Issue、Pull Request、命令面板、设置（通用/账户/会话/主题/辅助功能/语音听写/计算机操作）、定制页（浏览/已安装）、用户菜单、模式菜单、模型菜单、上下文菜单、会话配置，以及主要 tooltip/占位符。
- **未翻译**：MCP 市场里第三方服务器的名称与英文简介（注册表内容、条目繁多，按需在词典里补）、用户/仓库/用户名等动态数据、代码编辑器（Monaco）内的内容——注入器主动跳过 `monaco-editor`、`contenteditable`、`code`/`pre`。
- 必须通过启动器启动才有效；原生快捷方式启动仍是英文。
- 应用更新后界面文本若变化，只影响未匹配到的句子，补词典即可，不用重新适配。
- 注入只是改显示文本，不改任何应用状态与设置。

## 已验证

- 首页 / 设置页 / 定制页截图见 `shots/`（`zh-home.png`、`zh-settings.png`、`zh-extensions.png`）。
- 重载页面后仍为中文（`zh-after-reload.png`），证明新文档注入生效。
- 词典热重载、React 重渲染补翻均已实测。
