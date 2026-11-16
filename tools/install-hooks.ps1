# 启用"每次 commit 自动同步到远端"
#
# 用法（在项目根目录）：
#   .\tools\install-hooks.ps1
#
# 做的事：git config core.hooksPath tools/githooks
# 之后每次 commit 完成，post-commit 钩子会自动 git push origin <当前分支>。

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)

try {
    if (-not (Test-Path 'tools/githooks/post-commit')) {
        throw '找不到 tools/githooks/post-commit'
    }

    git config core.hooksPath tools/githooks
    if ($LASTEXITCODE -ne 0) { throw 'git config 执行失败' }

    $path = git config core.hooksPath
    Write-Host "✓ 已启用自动同步（core.hooksPath = $path）" -ForegroundColor Green
    Write-Host '  之后每次 commit 都会自动 push 到 origin'
    Write-Host '  停用：git config --unset core.hooksPath'
}
finally {
    Pop-Location
}
