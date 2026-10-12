<#
.SYNOPSIS
  从 GitHub Copilot 里摘掉 DSH 接入（MCP 服务器 + 个人技能）。
#>
[CmdletBinding()]
param(
  [string]$CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }),
  [string]$ServerName = 'dsh'
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$copilot = (Get-Command copilot -ErrorAction SilentlyContinue).Source
if (-not $copilot) {
  $sdkRoot = Join-Path $env:LOCALAPPDATA 'github-copilot-sdk\cli'
  if (Test-Path $sdkRoot) {
    $copilot = Get-ChildItem -Directory $sdkRoot | Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'copilot.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
}
if ($copilot) { & $copilot mcp remove $ServerName }

$cfgPath = Join-Path $CopilotHome 'mcp-config.json'
if (Test-Path $cfgPath) {
  $cfg = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json
  if ($cfg.mcpServers -and $cfg.mcpServers.PSObject.Properties[$ServerName]) {
    $cfg.mcpServers.PSObject.Properties.Remove($ServerName)
    $cfg | ConvertTo-Json -Depth 20 | Set-Content -Path $cfgPath -Encoding UTF8
    Write-Host "已从 $cfgPath 移除 $ServerName"
  }
}

$skillDir = Join-Path $CopilotHome 'skills\dsh'
if (Test-Path $skillDir) { Remove-Item -Recurse -Force $skillDir; Write-Host "已删除 $skillDir" }
Write-Host '卸载完成（新开的 Copilot 会话生效）。'
