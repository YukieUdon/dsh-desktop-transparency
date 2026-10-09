<#
.SYNOPSIS
  Restart DSH Desktop from outside the app's own process tree.

.DESCRIPTION
  Used through a Windows scheduled task on purpose: stopping the app also kills
  the agent session that would otherwise issue the restart, so the "stop, then
  start again" step has to outlive that session. See the ASCII wrapper that calls
  this script for the details.
#>
[CmdletBinding()]
param(
  [string]$DshExe = 'D:\Tools\DSH\DeepSeek Harness.exe',
  [int]$Port = 9222,
  [int]$StopWaitSeconds = 30,
  [int]$StartWaitSeconds = 90
)

$log = Join-Path $env:TEMP 'dsh-restart-task.log'
function Say([string]$m) { Add-Content -LiteralPath $log -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 }

Say '=== scheduled restart task started ==='
Say ("stopping all DeepSeek Harness processes (exe: {0})" -f $DshExe)
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$deadline = (Get-Date).AddSeconds($StopWaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) { break }
  Start-Sleep -Milliseconds 400
}
$left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
Say ("processes left after stop: {0}" -f $left)

Say ("launching {0} --remote-debugging-port={1}" -f $DshExe, $Port)
Start-Process -FilePath $DshExe -ArgumentList ("--remote-debugging-port={0}" -f $Port) -WorkingDirectory (Split-Path -Parent $DshExe)

$deadline = (Get-Date).AddSeconds($StartWaitSeconds)
$up = $false
while ((Get-Date) -lt $deadline) {
  try { Invoke-RestMethod ("http://127.0.0.1:{0}/json/list" -f $Port) -TimeoutSec 3 | Out-Null; $up = $true; break } catch { }
  Start-Sleep -Seconds 2
}
Say ("debug port answering: {0}" -f $up)
Say '=== scheduled restart task done ==='
