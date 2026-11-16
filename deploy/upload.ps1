# 从 Windows 一键上传原型到服务器
#
# 用法（在项目根目录）：
#   .\deploy\upload.ps1 -Server 1.2.3.4
#   .\deploy\upload.ps1 -Server 1.2.3.4 -User ubuntu -RemotePath /var/www/trip
#
# 依赖：Windows 10+ 自带的 ssh / scp；服务器需有 unzip（没有就 apt install unzip）

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$User = 'root',
    [string]$SshPort = '22',
    [string]$RemotePath = '/var/www/trip'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'prototype'
if (-not (Test-Path $src)) { throw "找不到 $src" }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw '未找到 ssh，请先在「设置 → 应用 → 可选功能」安装 OpenSSH 客户端' }

$target = "$User@$Server"
$stamp = (Get-Date -Format 'yyyyMMddHHmmss')
$zip = Join-Path $env:TEMP "trip-$stamp.zip"
$remoteZip = "/tmp/trip-$stamp.zip"
$remoteDir = "/tmp/trip-$stamp"

Write-Host "→ 打包 $src" -ForegroundColor Cyan
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip -Force
Write-Host ("   " + [math]::Round((Get-Item $zip).Length / 1KB, 1) + " KB")

Write-Host "→ 上传到 ${target}:$remoteZip" -ForegroundColor Cyan
& scp -P $SshPort $zip "${target}:$remoteZip"
if ($LASTEXITCODE -ne 0) { throw 'scp 失败（检查 IP / 端口 / 密钥）' }

Write-Host "→ 远程解压并部署到 $RemotePath" -ForegroundColor Cyan
$remoteCmd = @"
set -e
mkdir -p $remoteDir
unzip -oq $remoteZip -d $remoteDir
sudo mkdir -p $RemotePath
sudo rsync -a --delete $remoteDir/ $RemotePath/
sudo find $RemotePath -type d -exec chmod 755 {} \;
sudo find $RemotePath -type f -exec chmod 644 {} \;
rm -rf $remoteDir $remoteZip
echo DEPLOY_OK
"@
& ssh -p $SshPort $target $remoteCmd
if ($LASTEXITCODE -ne 0) { throw '远程部署失败（检查 sudo 权限 / rsync 是否安装）' }

Remove-Item $zip -Force
Write-Host '✓ 部署完成，刷新手机浏览器即可看到新版本' -ForegroundColor Green
Write-Host '  若已开 service worker，手机上可能需要下拉刷新两次，或杀掉重开' -ForegroundColor DarkGray
