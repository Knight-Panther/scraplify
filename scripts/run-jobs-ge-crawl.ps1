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

$dedupeEntryPoint = Join-Path $repositoryRoot 'dist/cli/run-dedupe.js'
if (-not (Test-Path -LiteralPath $dedupeEntryPoint -PathType Leaf)) {
    throw "Build output not found: $dedupeEntryPoint. Run 'npm run build' in $repositoryRoot first."
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
    "----- crawl exit code $exitCode -----" | Add-Content -LiteralPath $logFile

    # Run cross-source dedupe after every crawl attempt, not only a
    # successful one: even a run that ends in failure or a partial sweep can
    # still have written new listings before it stopped, and those need
    # canonicalizing same as any other. Found necessary 2026-09-15 (see
    # docs/STATUS.md's "Incident: runDedupe had not run since 2026-09-06"):
    # this wrapper is the one automated path a Task Scheduler registration
    # actually drives (register-jobs-ge-schedule.ps1), and with dedupe
    # calling into `--auto-link` off it does not merge or canonicalize
    # anything, leaving every listing a crawl adds invisible outside the
    # raw /listings view until someone remembers to run it by hand. `--auto-link`
    # is what actually closes that gap: `confirmed_same` pairs auto-merge
    # under scorePair's own high-confidence, multi-signal restriction (the
    # project's designed production behaviour, not a shortcut), and
    # everything less certain (`needs_review`/`probable_same`) is still only
    # ever queued for a human via the /review screen, never auto-decided.
    "----- $(Get-Date -Format o) -----" | Add-Content -LiteralPath $logFile
    & $NodePath '--env-file=.env' 'dist/cli/run-dedupe.js' '--auto-link' *>> $logFile
    $dedupeExitCode = $LASTEXITCODE
    "----- dedupe exit code $dedupeExitCode -----" | Add-Content -LiteralPath $logFile

    # concept section 19.1: a failed or skipped run must never pass
    # silently. A crawl that itself succeeded but left a failed dedupe pass
    # behind is not a clean run either, so it must not exit 0.
    if ($exitCode -eq 0 -and $dedupeExitCode -ne 0) {
        $exitCode = $dedupeExitCode
    }
} finally {
    Pop-Location
}

exit $exitCode
