# 用 GitHub Copilot 拉取项目

> 本文里的"实测"数据来自本机 2026-10-13 的实跑，网络环境会变，方法不变。

## 一、让 Copilot 替你拉（推荐顺序）

### 1. 直接在对话里说（桌面应用 / CLI 都行）

在 Copilot 的新会话里直接说：

> 把 \`owner/repo\` 克隆到 \`D:\\code\\repo\`，浅克隆就行

Copilot 会自己调用 git。三个关键事实：

- **用的是应用自带的 git**：\`%LOCALAPPDATA%\\github-copilot-git-2.53.0-4\\cmd\\git.exe\`，不依赖你 PATH 上的版本；
- **凭据走应用的登录态**：\`git-credential-copilot.exe\` 由应用进程内的 broker 授权，所以**私有仓库也能拉**，你不需要额外配 token（这个 helper 在应用之外单独跑会报 \`COPILOT_TRAMPOLINE_PORT not set\`，属于正常现象）；
- 需要网络：GitHub 不可达时它会失败，这时走第四节的兜底。

### 2. 应用 UI 直接打开仓库

\`\`\`powershell
& "C:\\Users\\<你>\\AppData\\Local\\Programs\\GitHub Copilot\\github.exe" open https://github.com/owner/repo
\`\`\`

（\`github.exe open\` 支持本地目录或 GitHub URL；应用会把它作为项目打开/检出到自己的工作区。）

应用内也有 "新建项目或会话" / "Add project" 入口，会列出你账号下的仓库。

### 3. Copilot CLI 非交互

\`\`\`bash
copilot -p "把 morluto/rea 浅克隆到 D:\\code\\rea，完成后告诉我提交号" --allow-all-tools
\`\`\`

## 二、本机网络实测（2026-10-13）

| 通道 | 命令 | 结果 |
| --- | --- | --- |
| HTTPS git 小操作 | \`git ls-remote https://github.com/...\` | ✅ 1.8s |
| SSH over 443 小操作 | \`git ls-remote ssh://git@ssh.github.com:443/...\` | ✅ 8.9s（认证 \`Hi lsp725jk!\`） |
| HTTPS 小仓库克隆 | \`git clone --depth 1 octocat/Hello-World\` | ✅ 3.8s |
| **大仓库克隆（53 MB）** | \`git clone morluto/rea\`（https 与 ssh 都试过） | ❌ **停滞**：10 分钟只拉到 1 个对象 |
| codeload 压缩包 | \`curl -L https://codeload.github.com/o/r/tar.gz/refs/heads/main\` | ✅ 稳定（8.8 MB / 约 2 分钟） |
| GitHub API | \`api.github.com\` | ✅ 额度 5000/5000 |

**结论：小操作正常，批量对象传输不稳。** 因此拉项目时：小仓库直接 \`git clone\`；大仓库先试 git，卡住就用压缩包。

## 三、提示词模板（给 Copilot 用）

\`\`\`
克隆 <owner/repo> 到 <绝对路径>。
要求：
1) 先浅克隆（--depth 1）；如果 2 分钟没有进展，就停掉，
   改用 codeload 压缩包：https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<branch>
   （分支不确定就先试 main 再试 master），解压到目标目录；
2) 完成后报告：提交号、文件数、分支名；
3) 如果是私有仓库，告诉我失败原因，别猜凭据。
\`\`\`

## 四、兜底脚本 \`gh-pull.ps1\`

装在本仓库根目录，逻辑就是上面的模板：**先 git（可浅克隆），超时/失败自动转 codeload 压缩包**，并在压缩包路径上补一个本地 git 仓库，方便日后对齐上游。

\`\`\`powershell
# 默认：深度 1 的克隆，失败自动兜底
powershell -File gh-pull.ps1 morluto/rea D:\\code\\rea

# 要完整历史
powershell -File gh-pull.ps1 morluto/rea D:\\code\\rea -Depth 0 -TimeoutSec 900

# 只用 git，不兜底
powershell -File gh-pull.ps1 owner/repo -WithGit

# URL 也能直接喂
powershell -File gh-pull.ps1 https://github.com/octocat/Hello-World
\`\`\`

实测（同一台机器）：

- \`octocat/Hello-World\` → 3.8s 走 git，拿到真实上游提交；
- 链路卡住时 → 3.7s 内完成"超时判定 + 压缩包下载 + 解压 + 建本地仓库"。

## 五、常见坑

| 现象 | 原因 / 处理 |
| --- | --- |
| \`Remote branch main not found\` | 默认分支是 master 或别的；脚本会自动去掉分支限制重试，或显式 \`-Branch master\` |
| 克隆到一半卡死 | 批量传输被限；用 \`gh-pull.ps1\` 或显式压缩包通道 |
| 子模块缺失 | \`git clone --recurse-submodules\`；压缩包通道**不含**子模块，需单独拉 |
| 大文件缺失 | 仓库用了 Git LFS，需要 \`git lfs pull\`；压缩包里是 LFS 指针文件 |
| 证书/吊销检查报错 | 你的 git 已配 \`http.schannelcheckrevoke=false\`；企业代理下再考虑 \`http.proxy\` |
| 想用国内镜像加速 | 第三方镜像有供应链风险：只用它**下载**，别用它替代 git 历史，且尽量核对上游 commit 或校验和 |
| 私有仓库 | 在 Copilot 应用里让 Copilot 拉（走应用登录态）；在裸终端里需要你自己的 SSH key 或 PAT |

## 六、一句话总结

**能连的时候让 Copilot 直接 \`git clone\`；连不稳的时候用 \`gh-pull.ps1\`（或同一思路的手工 codeload 命令）。** 两条路我都在本机跑通了，脚本里也把踩到的坑（分支名、ExitCode 判成败、超时清理）都处理掉了。
