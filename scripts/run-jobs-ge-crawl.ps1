[CmdletBinding()]
param(
    # Absolute path to node.exe, resolved once by register-jobs-ge-schedule.ps1
    # at registration time (a profile-loaded, interactive shell, where fnm's
    # PATH setup has already run) and passed in here - this wrapper itself
    # runs under Task Scheduler's `-NoProfile`, so fnm's own PATH hook never
    # runs for it, and a bare `node` call would fail to resolve on a machine
    # where Node is only ever put on PATH by that hook (adversarial review,
    # 2026-09-05, round 8's originally-deferred P2). Defaults to the bare
    # command for direct/manual invocation outside Task Scheduler, where the
    # caller's own shell has already resolved `node` onto PATH normally.
    [string]$NodePath = 'node'
)

# Wrapper invoked by the Windows Task Scheduler job (see
# register-jobs-ge-schedule.ps1) rather than calling node directly: Task
# Scheduler does not capture a process's stdout/stderr on its own, and
# concept docs/scraplify-concept.md section 19.1 requires that a failed or skipped
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
    throw "Expected $envFile (see README.md's Database section) - refusing to run without it rather than silently using an unconfigured environment."
}

$logDirectory = Join-Path $repositoryRoot 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory ('jobs-ge-crawl-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

Push-Location $repositoryRoot
try {
    "----- $(Get-Date -Format o) -----" | Add-Content -LiteralPath $logFile
    & $NodePath '--env-file=.env' 'dist/cli/run-jobs-ge-crawl.js' *>> $logFile
    $exitCode = $LASTEXITCODE
    "----- exit code $exitCode -----" | Add-Content -LiteralPath $logFile
} finally {
    Pop-Location
}

exit $exitCode
