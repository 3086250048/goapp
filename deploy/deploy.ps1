# Windows 入口：通过 WSL 调用唯一的一键部署脚本 deploy/deploy.sh。
#
# 用法：
#   .\deploy\deploy.ps1 -Remote root@1.2.3.4 -Domain trip.example.com

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Remote,
    [string]$Domain = "",
    [string]$RestoreFile = "",
    [string]$Branch = "master",
    [int]$SshPort = 22,
    [ValidateSet("0", "1")][string]$DemoMode = "1"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    throw "未找到 WSL。请安装 WSL，或在 Git Bash / Linux 中执行 ./deploy/deploy.sh"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$wslRoot = (& wsl wslpath -a -u $repoRoot).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "无法把项目目录转换为 WSL 路径"
}

$bashArgs = @(
    "--remote", $Remote,
    "--branch", $Branch,
    "--ssh-port", $SshPort,
    "--demo-mode", $DemoMode
)

if ($Domain) {
    $bashArgs += @("--domain", $Domain)
}
if ($RestoreFile) {
    $resolvedRestore = (Resolve-Path $RestoreFile -ErrorAction Stop).Path
    $wslRestore = (& wsl wslpath -a -u $resolvedRestore).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "无法把数据库备份路径转换为 WSL 路径"
    }
    $bashArgs += @("--restore-file", $wslRestore)
}

function Quote-Bash([string]$Value) {
    return "'" + $Value.Replace("'", "'\''") + "'"
}

$quoted = $bashArgs | ForEach-Object { Quote-Bash $_ }
$command = "cd $(Quote-Bash $wslRoot) && ./deploy/deploy.sh $($quoted -join ' ')"
& wsl bash -lc $command
exit $LASTEXITCODE
