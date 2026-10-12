<#
.SYNOPSIS
  以中文界面启动 GitHub Copilot（运行期注入汉化，不修改任何程序文件）。

.DESCRIPTION
  1) 用 WebView2 的远程调试参数启动 github.exe（已开着就复用）
  2) 常驻运行 inject.mjs，把 dict.zh.json 的译文注入界面，并在 React 重渲染后自动补翻
  3) Copilot 退出后自动结束注入器

.PARAMETER Port
  调试端口，默认 9333。

.PARAMETER Restart
  强制关闭已在运行的 Copilot 实例后再启动（原生实例没有调试端口时必须重启一次）。
#>
[CmdletBinding()]
param([int]$Port = 9333, [switch]$Restart)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $env:LOCALAPPDATA 'Programs\GitHub Copilot\github.exe'
if (-not (Test-Path $app)) { throw "找不到 GitHub Copilot：$app" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' }
if (-not $node -or -not (Test-Path $node)) { throw '找不到 node.exe（需要 Node 18+）' }

function Test-Port($p) {
  $c = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $p }
  return [bool]$c
}
function Get-AppProcess { Get-Process github -ErrorAction SilentlyContinue }

# 1) 需要时重启应用，让它带上调试端口
if (-not (Test-Port $Port)) {
  $running = Get-AppProcess
  if ($running) {
    if (-not $Restart) {
      Write-Host "检测到 Copilot 已在运行但未开启调试端口，正在重启一次（会话已持久化，不会丢失）…" -ForegroundColor Yellow
    }
    $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep -Seconds 6
    $still = Get-AppProcess
    if ($still) { $still | Stop-Process -Force; Start-Sleep -Seconds 3 }
  }
  Write-Host "正在启动 GitHub Copilot（中文界面）…" -ForegroundColor Cyan
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
  Start-Process -FilePath $app | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Port $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 700 }
}

if (-not (Test-Port $Port)) {
  Write-Warning "调试端口 $Port 未就绪，汉化未生效（应用可能覆盖了浏览器参数）。界面仍是英文。"
  exit 1
}
Write-Host "调试端口 $Port 已就绪，开始注入中文…" -ForegroundColor Green

# 2) 常驻注入器
$injector = Start-Process -FilePath $node -ArgumentList @((Join-Path $here 'inject.mjs'), '--port', $Port, '--dict', (Join-Path $here 'dict.zh.json')) -PassThru -WindowStyle Hidden
Write-Host "注入器已启动（PID $($injector.Id)）。关闭 Copilot 后本脚本会自动退出。" -ForegroundColor Green

# 3) 跟随应用生命周期
while ($true) {
  Start-Sleep -Seconds 3
  $p = Get-AppProcess
  if (-not $p) { break }
  if ($injector.HasExited) { $injector = Start-Process -FilePath $node -ArgumentList @((Join-Path $here 'inject.mjs'), '--port', $Port, '--dict', (Join-Path $here 'dict.zh.json')) -PassThru -WindowStyle Hidden }
}
if (-not $injector.HasExited) { $injector | Stop-Process -Force }
Write-Host 'Copilot 已退出，汉化注入器随之结束。' -ForegroundColor Cyan
