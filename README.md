# oh-dsh-copilot

把 **DeepSeek Harness（DSH）** 接进 **GitHub Copilot**，并把 **GitHub Copilot 桌面应用界面汉化**。两个东西合起来是一件事：
让本机的 Copilot 变成一个能随时喊 DSH 干活、且说中文的工作台。

| 部分 | 目录 | 一句话 |
| --- | --- | --- |
| ① DSH 接入 | `mcp/`、`skill/`、`install.ps1`、`test/` | 给 Copilot 装一个名为 `dsh` 的 MCP 服务器 + 一个个人技能，Copilot 的 agent 可以把整件事委派给 DSH |
| ② 界面汉化 | `copilot-zh/` | 启动器 + 运行期注入（854 词条 / 50 规则，含市场目录 198 条描述），把 Copilot 桌面应用界面变成中文，不改任何程序文件 |

---

# ① 把 DSH 接进 GitHub Copilot

## 装了什么

| 位置 | 内容 |
| --- | --- |
| `~/.copilot/mcp-config.json` | MCP 服务器 `dsh`（stdio，`node mcp/dsh-mcp-server.mjs`，timeout 30 分钟） |
| `~/.copilot/skills/dsh/SKILL.md` | 个人技能 `dsh-delegation`：教 Copilot 何时、怎么委派 |
| `mcp/dsh-mcp-server.mjs` | 桥本体，零依赖，约 500 行 |

暴露给 Copilot 的两个工具：

- `dsh_run` —— 把任务交给 DSH 跑一次，返回最终答复（支持 `cwd` / `session_id` 续跑 / `timeout_ms` / `include_trace`）
- `dsh_info` —— 接入自检：CLI 路径、版本、DSH_HOME、可用档案、默认工作目录

## 链路

```
GitHub Copilot agent
   └─ MCP 工具 dsh_run
        └─ mcp/dsh-mcp-server.mjs            （stdio JSON-RPC，零依赖）
             └─ "DeepSeek Harness.exe" --expose-internals <app.asar>/dsh/.../dsh-desktop-host/lib/cli.js \
                  --profile headless --json
                  ├─ 任务文本经 stdin 传入（不进命令行，无转义问题）
                  ├─ stdout：NDJSON 事件流（session / status / tool_call / text / final / error）
                  └─ 最终答复取 final 事件，连同退出码、耗时、会话 id 一起回给 Copilot
```

几个刻意为之的设计：

- **不经 cmd.exe / .cmd**：`dsh.cmd` 里的 `cli.js` 位于 `app.asar` 内，普通 fs 看不到，但 Electron 以
  `ELECTRON_RUN_AS_NODE=1` 运行时能正常加载；直接拉 exe 也就彻底绕开了 Windows 命令行引号问题。
  找不到 exe 时才回退到 `dsh.cmd`（此时用 verbatim 参数交给 cmd）。
- **任务走 stdin**：headless 档案支持从 stdin 读任务，任意引号、换行、中文都不会出问题。
- **默认档案固定 headless**：不读继承来的 `DSH_PROFILE`（DSH 桌面端会把它设成 `desktop`，
  而 desktop/web 由 Electron 应用独占，子进程拿来跑会被启动器拒绝）。
- **默认工作目录走 MCP roots**：Copilot 给 MCP 服务进程的 cwd 常常是 `~/.copilot`，
  所以服务端会主动发 `roots/list` 问客户端要工作区；拿不到才退回进程 cwd。

## 安装

```powershell
powershell -File install.ps1              # 注册 MCP + 安装技能 + 跑一遍自检
powershell -File install.ps1 -SkipTest    # 跳过自检
```

可重复执行（先 remove 再 add）。脚本自己找 node（PATH 优先，其次 DSH 自带运行时）、自己找 copilot CLI
（PATH 优先，其次 `%LOCALAPPDATA%\github-copilot-sdk\cli\*`）；找不到 copilot CLI 时直接合并写
`~/.copilot/mcp-config.json`。

## 验证

```powershell
powershell -File verify-all.ps1          # 安装 + 协议自检 + 真实 DSH 端到端 + 核对配置
node test/protocol-test.mjs              # 34 项协议/解析/错误路径自检（stub 驱动，不耗模型额度）
node test/live-test.mjs                  # 真实 DSH 跑一次（需要 DEEPSEEK_API_KEY 可见）
copilot mcp list ; copilot mcp get dsh   # 确认注册
copilot skill list                       # 应出现 dsh-delegation
```

在 Copilot 里验收：

> 用 dsh_run 让 DSH 回复一句话：桥接成功，然后把它的最终答复原文给我。

MCP 配置在会话启动时读取：已经开着的对话不会热加载，请新开一个会话。

## 用法

- `dsh_run({ task: "..." })` —— 任务写全（DSH 看不到这段对话）。
- `dsh_run({ task, cwd: "E:\\path\\to\\proj" })` —— 指定工作目录（建议总是显式传）。
- `dsh_run({ task, session_id: "session-xxx" })` —— 沿用上一次的 DSH 会话继续做（cwd 必须一致）。
- `dsh_run({ task, timeout_ms: 1800000, include_trace: true })` —— 加长超时并附上工具调用序列。

## 环境变量（给桥用）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_MCP_PROFILE` | `headless` | 要启动的 DSH 档案 |
| `DSH_MCP_DEFAULT_CWD` | 空 | 兜底工作目录（优先于 MCP roots） |
| `DSH_MCP_TIMEOUT_MS` | `900000` | 单次任务超时上限（工具参数可覆盖，上限 60 分钟） |
| `DSH_MCP_MAX_RESULT_CHARS` | `120000` | 返回给模型的文本上限 |
| `DSH_MCP_PROGRESS_MS` | `15000` | 进度通知间隔 |
| `DSH_INSTALL_ROOT` | `%LOCALAPPDATA%\Programs\DeepSeek Harness` | DSH 安装目录 |
| `DSH_CLI_EXE` / `DSH_CLI_ARGS` | 空 | 覆盖要启动的命令（测试用） |

## 排查

| 现象 | 处理 |
| --- | --- |
| Copilot 里看不到 dsh_run | 新开会话 / 重启应用；`copilot mcp list` 应显示 `dsh`；看 `~/.copilot/logs/` 最新日志 |
| `MISSING_CREDENTIAL: llm-deepseek` | 启动 Copilot 的进程要能读到 `DEEPSEEK_API_KEY`，或在 DSH 桌面端把密钥存进凭据服务 |
| `profile "desktop" is managed exclusively…` | 别把 `DSH_MCP_PROFILE` 设成 desktop/web，默认 headless 即可 |
| DSH 在 `~/.copilot` 里干活 | 客户端没给 roots，调用时显式传 `cwd` |
| 桥起不来 | 需要 node ≥ 18；诊断走 stderr（`[dsh-mcp] ready ...`） |

## 卸载

```powershell
powershell -File uninstall.ps1
```

---

# ② GitHub Copilot 界面汉化

运行期注入式汉化：**不改任何程序文件**，可逆、抗自动更新。详见 [copilot-zh/README.md](copilot-zh/README.md)。

```powershell
# 双击桌面快捷方式「GitHub Copilot 中文版」，或：
powershell -NoProfile -ExecutionPolicy Bypass -File copilot-zh/launch-copilot-zh.ps1
```

原理：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 启动应用，用 CDP 常驻注入词典；
`MutationObserver` 负责在 React 重渲染后补翻，`Page.addScriptToEvaluateOnNewDocument` 负责刷新后自动再生效，
词典（`copilot-zh/dict.zh.json`）改动后 3 秒内热重载。

为什么不直接改二进制：应用前端资源是明文编译进 `github.exe` 的，没有本地化资源也没有语言设置；
二进制里改字符串必须保持字节长度不变，而中文字符（UTF-8 每字 3 字节）几乎塞不进英文词槽，还会破坏签名与自动更新。

---

## 目录

```
oh-dsh-copilot/
├─ mcp/dsh-mcp-server.mjs        ① 桥本体（零依赖 stdio MCP 服务器）
├─ skill/dsh/SKILL.md            ① Copilot 个人技能
├─ test/protocol-test.mjs        ① 34 项协议自检（stub 驱动）
├─ test/live-test.mjs            ① 真实 DSH 端到端
├─ test/stub-dsh.mjs             ① 假 DSH CLI
├─ install.ps1 / uninstall.ps1 / verify-all.ps1
├─ tools/dsh-asar.cjs            读 Electron app.asar 的排查小工具
└─ copilot-zh/                   ② 汉化
   ├─ launch-copilot-zh.ps1      启动器（开调试端口 + 常驻注入）
   ├─ inject.mjs                 注入器（CDP + 词典热重载）
   ├─ dict.zh.json               汉化词典
   ├─ lib/cdp.mjs                极简 CDP 客户端
   ├─ harvest*.mjs / collect-all.mjs / act.mjs / snap.mjs
   └─ shots/                     汉化效果截图
```

## 边界

- `dsh_run` 是**一次性任务**：跑完即退出，不能在 Copilot 的对话里和 DSH 来回追问；多步工作用 `session_id` 分几次喂。
- DSH 用**自身权限**真的改文件、跑命令；只在用户已授权的工作目录里让它干活。
- 汉化只对**通过启动器启动**的实例生效；第三方 MCP 市场的英文简介、用户名等动态内容不翻译。
- 两者都不改动 GitHub Copilot 的安装文件，也不改任何账号设置。

## 许可

MIT，见 [LICENSE](LICENSE)。
