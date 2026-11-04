param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
# Some managed shells omit this Windows variable; fill it for child processes only.
if (-not $env:SystemDrive -and $env:SystemRoot) { $env:SystemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd('\') }
# Normalize command lookup only for this process; do not change system settings.
$nativeExtensions = @($env:PATHEXT -split ';') + @('.COM', '.EXE', '.BAT', '.CMD')
$env:PATHEXT = ($nativeExtensions | Where-Object { $_ } | Select-Object -Unique) -join ';'
$studioRoot = $PSScriptRoot
$studioPort = 1421
if ($env:SIDEX_PORT -and (-not [int]::TryParse($env:SIDEX_PORT, [ref]$studioPort) -or $studioPort -lt 1 -or $studioPort -gt 65535)) { throw 'SIDEX_PORT must be between 1 and 65535.' }
$studioUrl = "http://127.0.0.1:$studioPort"
$homeUrl = "$studioUrl/home"
$sessionUrl = "$studioUrl/__latex/session"
$runtimeDirectory = Join-Path $studioRoot '.runtime'
function Get-StudioSession {
  try {
    $session = Invoke-RestMethod -Uri $sessionUrl -TimeoutSec 2
    if ($session.runtime -eq 'local' -and $session.token) { return $session }
  } catch {}
  return $null
}
function Invoke-StudioNpm([string[]]$NpmArguments) {
  $outFile = Join-Path $runtimeDirectory 'npm.stdout.log'
  $errFile = Join-Path $runtimeDirectory 'npm.stderr.log'
  $cliArgument = '"' + $script:npmCli + '"'
  $process = Start-Process -FilePath $nodeExe -ArgumentList (@($cliArgument) + $NpmArguments) -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile -Wait -PassThru
  if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Encoding UTF8 | Write-Host }
  if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile -Encoding UTF8 | Write-Host }
  if ($process.ExitCode -ne 0) { throw "npm $($NpmArguments -join ' ') failed (exit $($process.ExitCode)). See .runtime/npm.stderr.log." }
}
function Test-BuildRequired {
  $entry = Join-Path $studioRoot 'dist-latex/home.html'
  if (-not (Test-Path -LiteralPath $entry)) { return $true }
  if (-not (Test-Path -LiteralPath (Join-Path $studioRoot 'dist-latex/latex.html'))) { return $true }
  $builtAt = (Get-Item -LiteralPath $entry).LastWriteTimeUtc
  foreach ($relative in @('home.html', 'latex.html', 'vite.latex.config.ts', 'package.json', 'package-lock.json')) {
    $inputPath = Join-Path $studioRoot $relative
    if ((Test-Path -LiteralPath $inputPath) -and (Get-Item -LiteralPath $inputPath).LastWriteTimeUtc -gt $builtAt) { return $true }
  }
  foreach ($relative in @('src/latex', 'scripts/latex', 'public')) {
    $inputPath = Join-Path $studioRoot $relative
    if (Test-Path -LiteralPath $inputPath) {
      foreach ($item in Get-ChildItem -LiteralPath $inputPath -Recurse -File) {
        if ($item.LastWriteTimeUtc -gt $builtAt) { return $true }
      }
    }
  }
  return $false
}
try {
  $running = Get-StudioSession
  if (-not $running) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 22.11 or newer is required. Install the current LTS from https://nodejs.org/ and run this file again.' }
    $nodeExe = $nodeCommand.Source
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $versionFile = Join-Path $runtimeDirectory 'node-version.log'
    $versionProcess = Start-Process -FilePath $nodeExe -ArgumentList @('--version') -WindowStyle Hidden -RedirectStandardOutput $versionFile -Wait -PassThru
    $nodeVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim().TrimStart('v')
    if ($versionProcess.ExitCode -ne 0 -or ([version]$nodeVersion -lt [version]'22.11.0')) { throw 'Node.js 22.11 or newer is required. Install a current LTS release from https://nodejs.org/.' }
    $npmFound = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmFound) { throw 'npm.cmd was not found. Reinstall Node.js with npm enabled.' }
    $script:npmCommand = $npmFound.Source
    $npmCandidates = @((Join-Path (Split-Path $nodeExe) 'node_modules/npm/bin/npm-cli.js'), (Join-Path (Split-Path $script:npmCommand) 'node_modules/npm/bin/npm-cli.js'))
    $script:npmCli = $npmCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $script:npmCli) { throw 'The npm CLI could not be found beside Node.js. Reinstall Node.js with npm.' }
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $lockFile = Join-Path $studioRoot 'package-lock.json'
    if (-not (Test-Path -LiteralPath $lockFile)) { throw 'package-lock.json is missing. Download a complete source checkout.' }
    $lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash
    $stamp = Join-Path $runtimeDirectory 'dependencies.lock.sha256'
    $installedHash = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
    Push-Location -LiteralPath $studioRoot
    try {
      if (-not (Test-Path -LiteralPath (Join-Path $studioRoot 'node_modules')) -or $installedHash -ne $lockHash) {
        Write-Host 'Installing locked dependencies (first run or lockfile changed)...'
        Invoke-StudioNpm -NpmArguments @('ci', '--no-audit', '--no-fund')
        Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ascii
      }
      if (Test-BuildRequired) {
        Write-Host 'Building SideX LaTeX Studio...'
        Invoke-StudioNpm -NpmArguments @('run', 'latex:build')
      }
    } finally { Pop-Location }
    $inputFile = Join-Path $runtimeDirectory 'empty.stdin'
    [System.IO.File]::WriteAllText($inputFile, '')
    # Launch hidden; the browser is the user-facing window. Paths with spaces and
    # non-ASCII names are passed as native cmdlet parameters, not shell fragments.
    $service = Start-Process -FilePath $nodeExe -ArgumentList @('scripts/latex/serve.mjs') -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardInput $inputFile -RedirectStandardOutput (Join-Path $studioRoot 'latex-service.stdout.log') -RedirectStandardError (Join-Path $studioRoot 'latex-service.stderr.log') -PassThru
    $service.Id | Set-Content -LiteralPath (Join-Path $studioRoot 'latex-service.pid') -Encoding ascii
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      if (Get-StudioSession) { $ready = $true; break }
      if ($service.HasExited) { break }
      Start-Sleep -Milliseconds 200
    }
    if (-not $ready) {
      $details = Get-Content -LiteralPath (Join-Path $studioRoot 'latex-service.stderr.log') -Raw -ErrorAction SilentlyContinue
      throw "SideX LaTeX Studio did not become ready on port $studioPort. Another application may be using that port. $details"
    }
  }
  Write-Host "SideX LaTeX Studio is ready: $homeUrl"
  if (-not $NoBrowser) { Start-Process $homeUrl }
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
