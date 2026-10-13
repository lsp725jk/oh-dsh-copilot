<#
.SYNOPSIS
  从 GitHub 拉取仓库，自动在「git 克隆」和「codeload 压缩包」之间选条能走通的路。

.DESCRIPTION
  背景：这台机器到 github.com 的小操作（ls-remote）很快，但**批量对象传输经常停滞**，
  而 codeload.github.com（压缩包通道）稳定可用。本脚本因此：
    1) 默认先试 git 克隆（可选 --depth 1），带超时，卡住就放弃；
    2) 失败则回退到 codeload 压缩包（main → master 自动探测），解压到目标目录；
    3) 回退路径会 git init + 提交一次，便于日后链路恢复时 git fetch 对齐上游。

.PARAMETER Repo
  owner/name、github.com/owner/name 或完整 URL。

.PARAMETER Dest
  目标目录，默认 <当前目录>\<name>。

.PARAMETER Branch
  分支/标签，默认 main（回退时会自动试 master）。

.PARAMETER WithGit
  只用 git 克隆（浅克隆 -Depth 1），不用压缩包回退。

.PARAMETER Depth
  git 浅克隆深度，0 表示完整历史（默认 1）。

.EXAMPLE
  powershell -File gh-pull.ps1 morluto/rea D:\code\rea
  powershell -File gh-pull.ps1 https://github.com/octocat/Hello-World -WithGit
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Repo,
  [Parameter(Position = 1)][string]$Dest,
  [string]$Branch = 'main',
  [switch]$WithGit,
  [int]$Depth = 1,
  [int]$TimeoutSec = 300
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ---- 解析 owner/name ----
$slug = $Repo -replace '^https?://', '' -replace '^git@[^:]+:', '' -replace '\.git$', ''
$slug = ($slug -split '/')[-2..-1] -join '/'
if ($slug -notmatch '^[\w.-]+/[\w.-]+$') { throw "无法识别仓库：$Repo（应为 owner/name）" }
$owner, $name = $slug -split '/'
if (-not $Dest) { $Dest = Join-Path (Get-Location).Path $name }
$Dest = [System.IO.Path]::GetFullPath($Dest)

Write-Host "仓库: $owner/$name" -ForegroundColor Cyan
Write-Host "目标: $Dest" -ForegroundColor Cyan
if (Test-Path $Dest) { throw "目标已存在：$Dest" }

function Test-IsGitRepo([string]$dir) {
  if (-not (Test-Path (Join-Path $dir '.git'))) { return $false }
  $null = git -C $dir rev-parse --is-inside-work-tree 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Invoke-GitCloneAttempt([string]$branch) {
  $gitArgs = @('clone', '--progress')
  if ($Depth -gt 0) { $gitArgs += @('--depth', "$Depth") }
  if ($branch) { $gitArgs += @('--branch', $branch) }
  $gitArgs += @("https://github.com/$owner/$name.git", $Dest)
  $tag = [guid]::NewGuid().ToString('N')
  $log = Join-Path $env:TEMP ("gh-pull-git-$tag.out.log")
  $errLog = Join-Path $env:TEMP ("gh-pull-git-$tag.err.log")
  $p = Start-Process -FilePath 'git' -ArgumentList $gitArgs -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog
  try { Wait-Process -Id $p.Id -Timeout $TimeoutSec -ErrorAction Stop } catch {
    Write-Warning "git 克隆超时（${TimeoutSec}s），判定链路不通"
    if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue }
    return @{ ok = $false; timedOut = $true; log = $errLog }
  }
  # 注意：Start-Process 带输出重定向时 $p.ExitCode 可能为空，不能用它判成败；
  # 直接问 git：这个目录是不是一个仓库。
  $ok = Test-IsGitRepo $Dest
  if (-not $ok) {
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue }
    return @{ ok = $false; timedOut = $false; log = $errLog }
  }
  return @{ ok = $true; timedOut = $false; log = $errLog }
}

function Try-GitClone {
  Write-Host "→ 尝试 git 克隆（${TimeoutSec}s 超时，分支 $Branch）…"
  $r = Invoke-GitCloneAttempt $Branch
  if ($r.ok) { return $true }
  if (-not $r.timedOut) {
    Write-Host "→ 分支 $Branch 不适用或克隆失败，改试远端默认分支…"
    $r2 = Invoke-GitCloneAttempt $null
    if ($r2.ok) { return $true }
  }
  if (Test-Path $r.log) { Get-Content $r.log -TotalCount 3 | ForEach-Object { "    git: " + $_ } }
  return $false
}

function Get-Tarball([string]$ref) {
  $url = "https://codeload.github.com/$owner/$name/tar.gz/refs/heads/$ref"
  $tmp = Join-Path $env:TEMP ("gh-pull-" + [guid]::NewGuid().ToString('N') + ".tar.gz")
  Write-Host "→ 下载压缩包 $url"
  & curl.exe -L --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 20 --max-time 1800 -s -o $tmp $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 200) { return $null }
  return $tmp
}

$ok = $false
if ($WithGit) {
  $ok = Try-GitClone
} else {
  $ok = Try-GitClone
  if (-not $ok) {
    $tgz = $null
    foreach ($ref in @($Branch, 'master') | Select-Object -Unique) {
      $tgz = Get-Tarball $ref
      if ($tgz) { $usedRef = $ref; break }
    }
    if ($tgz) {
      $stage = Join-Path $env:TEMP ("gh-pull-x-" + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force -Path $stage | Out-Null
      tar -xzf $tgz -C $stage
      $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
      if ($inner) {
        Move-Item $inner.FullName $Dest
        Remove-Item -Recurse -Force $stage, $tgz -ErrorAction SilentlyContinue
        # 建一个本地仓库，方便日后 fetch 对齐上游
        git -C $Dest init -q -b main 2>$null | Out-Null
        git -C $Dest remote add origin "https://github.com/$owner/$name.git" 2>$null | Out-Null
        git -C $Dest add -A 2>$null | Out-Null
        git -C $Dest -c user.name=$owner -c user.email="$owner@users.noreply.github.com" commit -q -m "snapshot: $owner/$name $usedRef (via codeload)" 2>$null | Out-Null
        Write-Host "✓ 已用压缩包拉取 $owner/$name@$usedRef（含本地 git 仓库，无上游历史）" -ForegroundColor Green
        Write-Host "  链路恢复后可执行："
        Write-Host ("    git -C '" + $Dest + "' fetch --depth 1 origin " + $usedRef)
        Write-Host ("    git -C '" + $Dest + "' reset --hard FETCH_HEAD")
        exit 0
      }
      Remove-Item -Recurse -Force $stage, $tgz -ErrorAction SilentlyContinue
    }
    Write-Error "两条通道都失败：请检查网络，或稍后重试 git 克隆。"
    exit 1
  }
}

if ($ok) {
  $n = (Get-ChildItem -Recurse -File $Dest | Measure-Object).Count
  $mb = [Math]::Round((Get-ChildItem -Recurse -File $Dest | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
  $([char]0x2713) | Out-Null
  Write-Host "✓ git 克隆完成：$n 个文件 / $mb MB" -ForegroundColor Green
}
