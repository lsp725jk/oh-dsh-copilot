<#
.SYNOPSIS
  一键安装 + 验证：把 DeepSeek Harness（DSH）接入 GitHub Copilot。
  步骤：注册 MCP 服务器与个人技能 → 协议自检 → 真实 DSH 端到端 → 核对配置。
  需要写 ~/.copilot 与 ~/.dsh，请在放开沙箱的终端里运行。
#>
[CmdletBinding()]
param([switch]$SkipLive, [switch]$SkipInstall, [switch]$SkipTest)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'verify.log'
try { Start-Transcript -Path $log -Force | Out-Null } catch { Write-Host "transcript 不可用：$_" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' }
Write-Host "node = $node"
Write-Host "project = $root"

if (-not $SkipInstall) {
  Write-Host ''
  Write-Host '### 1) 注册到 GitHub Copilot' -ForegroundColor Cyan
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'install.ps1') -SkipTest
  Write-Host "install exit = $LASTEXITCODE"
}

if (-not $SkipTest) {
  Write-Host ''
  Write-Host '### 2) 协议自检（stub 驱动，不耗模型额度）' -ForegroundColor Cyan
  & $node (Join-Path $root 'test\protocol-test.mjs')
  Write-Host "protocol-test exit = $LASTEXITCODE"
}

if (-not $SkipLive) {
  Write-Host ''
  Write-Host '### 3) 真实 DSH 端到端（会消耗 DSH 模型额度）' -ForegroundColor Cyan
  $env:LIVE_RESUME = '1'
  & $node (Join-Path $root 'test\live-test.mjs')
  Write-Host "live-test exit = $LASTEXITCODE"
  Remove-Item Env:LIVE_RESUME -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '### 4) 核对' -ForegroundColor Cyan
$copilot = (Get-Command copilot -ErrorAction SilentlyContinue).Source
if (-not $copilot) {
  $sdkRoot = Join-Path $env:LOCALAPPDATA 'github-copilot-sdk\cli'
  if (Test-Path $sdkRoot) {
    $copilot = Get-ChildItem -Directory $sdkRoot | Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'copilot.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
}
Write-Host "copilot = $copilot"
if ($copilot) {
  Write-Host '--- copilot mcp list ---'
  & $copilot mcp list
  Write-Host '--- copilot mcp get dsh ---'
  & $copilot mcp get dsh
  Write-Host '--- copilot skill list ---'
  & $copilot skill list
}
$cfg = Join-Path $env:USERPROFILE '.copilot\mcp-config.json'
Write-Host "--- $cfg ---"
if (Test-Path $cfg) { Get-Content -Raw -Encoding UTF8 $cfg } else { Write-Host '(不存在)' }
$skill = Join-Path $env:USERPROFILE '.copilot\skills\dsh\SKILL.md'
Write-Host "--- skill: $skill $(if (Test-Path $skill) { (Get-Item $skill).Length.ToString() + ' bytes' } else { '缺失' }) ---"
Write-Host ''
Write-Host 'ALL DONE'
try { Stop-Transcript | Out-Null } catch {}
