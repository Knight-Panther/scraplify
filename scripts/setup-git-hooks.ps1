[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}

$repositoryRoot = $repositoryRoot.Trim()
$hookPath = Join-Path $repositoryRoot '.githooks/pre-commit'
if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
    throw "Expected hook not found: $hookPath"
}

git -C $repositoryRoot config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to configure core.hooksPath.'
}

$configuredPath = git -C $repositoryRoot config --get core.hooksPath
if ($configuredPath -ne '.githooks') {
    throw "Unexpected core.hooksPath value: $configuredPath"
}

Write-Host 'Git hooks configured: core.hooksPath=.githooks'
