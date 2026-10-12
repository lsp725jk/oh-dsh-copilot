<#
.SYNOPSIS
  把 DeepSeek Harness（DSH）接入 GitHub Copilot：注册 MCP 服务器 + 安装个人技能。

.DESCRIPTION
  1) 找 node.exe（PATH 上的 node，或 DSH 自带运行时）
  2) 用 copilot mcp add 把 mcp/dsh-mcp-server.mjs 注册成名为 dsh 的 stdio MCP 服务器
     （找不到 copilot CLI 时直接合并 ~/.copilot/mcp-config.json）
  3) 把 skill/dsh/SKILL.md 装到 ~/.copilot/skills/dsh/
  4) 跑一遍桥自检（stub 驱动，不需要 Copilot 也不需要真实 DSH 任务）

.PARAMETER CopilotHome
  Copilot 配置目录，默认 $env:COPILOT_HOME 或 ~/.copilot。

.PARAMETER TimeoutMs
  写进 MCP 配置的单次调用超时，默认 1800000（30 分钟）。

.EXAMPLE
  pwsh -File install.ps1
  pwsh -File install.ps1 -SkipTest
#>
[CmdletBinding()]
param(
  [string]$CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }),
  [string]$ServerName = 'dsh',
  [int]$TimeoutMs = 1800000,
  [switch]$SkipTest
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'mcp\dsh-mcp-server.mjs'
$skillSrc = Join-Path $root 'skill\dsh\SKILL.md'
if (-not (Test-Path $server)) { throw "找不到桥文件：$server" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

# ---------------------------------------------------------------- 1) node
Write-Step '定位 node.exe'
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) {
  $cand = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $cand) { $node = $cand }
}
if (-not $node) { throw '找不到 node.exe。请安装 Node.js 18+，或先启动一次 DSH 桌面端以生成自带运行时。' }
$nodeVersion = (& $node --version) -replace '^v', ''
Write-Ok "node: $node (v$nodeVersion)"
if ([int]($nodeVersion.Split('.')[0]) -lt 18) { throw "node 版本过低（v$nodeVersion），需要 18+" }

# ---------------------------------------------------------------- 2) copilot CLI
Write-Step '定位 copilot CLI'
$copilot = $null
$cc = Get-Command copilot -ErrorAction SilentlyContinue
if ($cc) { $copilot = $cc.Source }
if (-not $copilot) {
  $sdkRoot = Join-Path $env:LOCALAPPDATA 'github-copilot-sdk\cli'
  if (Test-Path $sdkRoot) {
    $copilot = Get-ChildItem -Directory $sdkRoot |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'copilot.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
  }
}
if ($copilot) { Write-Ok "copilot: $copilot" } else { Write-Ok '未找到 copilot CLI，将直接写 mcp-config.json' }

# ---------------------------------------------------------------- 3) 注册 MCP
Write-Step "注册 MCP 服务器 '$ServerName'"
$registered = $false
if ($copilot) {
  # 原生命令往 stderr 写错误（例如 dsh 尚未注册）不该终止脚本，因此这一段放宽 ErrorActionPreference
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $copilot mcp remove $ServerName 2>&1 | Out-Null
  & $copilot mcp add $ServerName --tools '*' --timeout $TimeoutMs -- $node $server
  $addExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($addExit -eq 0) { $registered = $true; Write-Ok 'copilot mcp add 成功' }
  else { Write-Warning "copilot mcp add 退出码 $addExit，改用直接写配置文件" }
}

$cfgPath = Join-Path $CopilotHome 'mcp-config.json'
if (-not $registered) {
  New-Item -ItemType Directory -Force -Path $CopilotHome | Out-Null
  $cfg = if (Test-Path $cfgPath) { Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json } else { New-Object psobject }
  if (-not $cfg.PSObject.Properties['mcpServers']) {
    $cfg | Add-Member -MemberType NoteProperty -Name mcpServers -Value (New-Object psobject)
  }
  if ($cfg.mcpServers.PSObject.Properties[$ServerName]) { $cfg.mcpServers.PSObject.Properties.Remove($ServerName) }
  $entry = [pscustomobject]@{
    type    = 'stdio'
    command = $node
    args    = @($server)
    tools   = '*'
    timeout = $TimeoutMs
  }
  $cfg.mcpServers | Add-Member -MemberType NoteProperty -Name $ServerName -Value $entry
  $cfg | ConvertTo-Json -Depth 20 | Set-Content -Path $cfgPath -Encoding UTF8
  Write-Ok "已写入 $cfgPath"
}

# ---------------------------------------------------------------- 4) 技能
Write-Step '安装个人技能'
$skillDir = Join-Path $CopilotHome 'skills\dsh'
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
Copy-Item $skillSrc (Join-Path $skillDir 'SKILL.md') -Force
Write-Ok "已安装 $skillDir\SKILL.md"

# ---------------------------------------------------------------- 5) 自检
if (-not $SkipTest) {
  Write-Step '桥自检（stub 驱动，不消耗模型额度）'
  & $node (Join-Path $root 'test\protocol-test.mjs')
  if ($LASTEXITCODE -ne 0) { Write-Warning '自检未全部通过，请把上面的失败明细贴给我' }
  else { Write-Ok '自检全部通过' }
}

Write-Host ''
Write-Host '接入完成。下一步：' -ForegroundColor Yellow
Write-Host '  1) 在已经打开的 GitHub Copilot 会话里，新开一个会话（MCP 配置在会话启动时读取）。'
Write-Host '  2) 验证：copilot mcp list   应看到 dsh'
Write-Host '  3) 直接用自然语言让它干活，例如：'
Write-Host '     "用 dsh_run 让 DSH 在 <某目录> 里做 <某件事>"'
Write-Host '  4) 排查：让 Copilot 调 dsh_info，或看 ~/.copilot/logs/ 的最新日志。'
