[CmdletBinding()]
param()

# Wrapper invoked by the Windows Task Scheduler job (see
# register-jobs-ge-schedule.ps1) rather than calling node directly: Task
# Scheduler does not capture a process's stdout/stderr on its own, and
# concept docs/scraplify-concept.md §19.1 requires that a failed or skipped
# run never pass silently, so every invocation's output has to land
# somewhere a person can actually find it afterwards.
$ErrorActionPreference = 'Stop'

$repositoryRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    throw 'Run this script from inside the scraplify Git repository.'
}
$repositoryRoot = $repositoryRoot.Trim()

$entryPoint = Join-Path $repositoryRoot 'dist/cli/run-jobs-ge-crawl.js'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Build output not found: $entryPoint. Run 'npm run build' in $repositoryRoot first."
}

$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Expected $envFile (see README.md's Database section) — refusing to run without it rather than silently using an unconfigured environment."
}

$logDirectory = Join-Path $repositoryRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory ('jobs-ge-crawl-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

Push-Location $repositoryRoot
try {
    "----- $(Get-Date -Format o) -----" | Add-Content -LiteralPath $logFile
    & node '--env-file=.env' 'dist/cli/run-jobs-ge-crawl.js' *>> $logFile
    $exitCode = $LASTEXITCODE
    "----- exit code $exitCode -----" | Add-Content -LiteralPath $logFile
} finally {
    Pop-Location
}

exit $exitCode
