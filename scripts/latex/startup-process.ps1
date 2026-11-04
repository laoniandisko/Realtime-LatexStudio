# PowerShell 5.1-compatible visible progress for hidden child processes.
function Stop-StudioProcessTree([System.Diagnostics.Process]$Child) {
  if (-not $Child -or $Child.HasExited) { return }
  $killer = Join-Path $env:SystemRoot 'System32/taskkill.exe'
  try {
    $stop = Start-Process -FilePath $killer -ArgumentList @('/PID', [string]$Child.Id, '/T', '/F') -WindowStyle Hidden -Wait -PassThru
    if ($stop.ExitCode -ne 0 -and -not $Child.HasExited) { $Child.Kill() }
  } catch { if (-not $Child.HasExited) { $Child.Kill() } }
}
function Invoke-StudioProcess {
  param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [Parameter(Mandatory=$true)][string]$OutputFile,
    [Parameter(Mandatory=$true)][string]$ErrorFile,
    [string]$Stage = 'Task',
    [ValidateRange(1,3600)][int]$TimeoutSeconds = 600,
    [ValidateRange(1,60)][int]$HeartbeatSeconds = 8
  )
  $child = $null
  $readers = @()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $lastOutput = 0.0
  $timedOut = $false
  try {
    $child = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $OutputFile -RedirectStandardError $ErrorFile -PassThru
    # Retain the process handle so even a very short task keeps its exit code.
    $null = $child.Handle
    foreach ($file in @($OutputFile, $ErrorFile)) {
      $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      $readers += New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    }
    Write-Host ("[{0}] Logs: {1}" -f $Stage, $OutputFile)
    while ($true) {
      foreach ($reader in $readers) {
        $chunk = $reader.ReadToEnd()
        if ($chunk.Length) { Write-Host -NoNewline $chunk; $lastOutput = $clock.Elapsed.TotalSeconds }
      }
      if ($child.HasExited) { break }
      if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        $timedOut = $true
        Stop-StudioProcessTree -Child $child
        break
      }
      if ($clock.Elapsed.TotalSeconds - $lastOutput -ge $HeartbeatSeconds) {
        Write-Host ("[{0}] Still running ({1}s elapsed, limit {2}s). Waiting for downloads or install scripts..." -f $Stage, [int]$clock.Elapsed.TotalSeconds, $TimeoutSeconds)
        $lastOutput = $clock.Elapsed.TotalSeconds
      }
      Start-Sleep -Milliseconds 200
      $child.Refresh()
    }
    $child.WaitForExit()
    # Flush output written immediately before process exit.
    foreach ($reader in $readers) {
      $chunk = $reader.ReadToEnd()
      if ($chunk.Length) { Write-Host -NoNewline $chunk }
    }
    if ($timedOut) { throw ("{0} exceeded {1}s and was stopped. Check the network, npm registry/proxy, or native build tools. Logs: {2} and {3}" -f $Stage, $TimeoutSeconds, $OutputFile, $ErrorFile) }
    $exitCode = $child.ExitCode
    if ($exitCode -ne 0) { throw ("{0} failed (exit {1}, {2}s elapsed). Logs: {3} and {4}" -f $Stage, $exitCode, [int]$clock.Elapsed.TotalSeconds, $OutputFile, $ErrorFile) }
    Write-Host ("[{0}] Completed in {1:N1}s." -f $Stage, $clock.Elapsed.TotalSeconds)
  } finally {
    if ($child -and -not $child.HasExited) { Stop-StudioProcessTree -Child $child }
    foreach ($reader in $readers) { $reader.Dispose() }
    $clock.Stop()
  }
}
