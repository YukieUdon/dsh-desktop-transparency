<#
.SYNOPSIS
  Prove, on the freshly restarted DSH Desktop window, that the sidebar black bar
  is gone from the *installed* patch (not just from a temporary in-page tweak).

.DESCRIPTION
  Restarting the desktop app also ends the desktop host, i.e. the Web GUI session
  that usually does the checking. This script therefore runs detached: it waits for
  the new window, reads the real computed style of the fade element over CDP,
  captures the window, measures the pixels of the band region and writes a verdict.

  Evidence is appended to build\verify-blackbar-after-restart.log, and the capture
  is saved as build\final-window.png.
#>
[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$DshExe = 'D:\Tools\DSH\DeepSeek Harness.exe'
)

$ErrorActionPreference = 'Continue'
$pkgRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$log = Join-Path $pkgRoot 'build\verify-blackbar-after-restart.log'
$shot = Join-Path $pkgRoot 'build\final-window.png'
$node = 'C:\Users\ZYD\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$python = 'C:\Users\ZYD\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

function Say([string]$m) {
  $line = "{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

Say "=== verifier started (port $Port) — waiting for the restarted window ==="

# wait for the new window. Two cases have to work: (a) the app is down right now and
# comes back later, (b) the app was already restarted before this script looked (the
# scheduled-task restart does that: it stops and starts within a second). An earlier
# version insisted on seeing the port drop first and then waited forever in case (b).
$page = $null
$deadline = (Get-Date).AddSeconds(60)
$sawDown = $false
while ((Get-Date) -lt $deadline) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
    $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
    if ($page) {
      if ($sawDown) { break }
      Say "window is up: $($page.title)"
      break
    }
  } catch {
    if (-not $sawDown) { $sawDown = $true; Say "debug port went down (old window gone)" }
  }
  Start-Sleep -Seconds 2
}
if (-not $page) { Say "FAILED: no page target appeared within 60s"; exit 1 }
Say "new window target: $($page.title) $($page.url)"
Start-Sleep -Seconds 4   # let the app settle (webContents + insertCSS)

# --- 1. computed style of the fade element over CDP ---------------------------
$exprFile = Join-Path $pkgRoot 'tools\cdp-check-fade-gone.js'
& $node (Join-Path $pkgRoot 'tools\cdp-eval.mjs') (Join-Path $pkgRoot 'build\verify-blackbar-after-restart.json') "$Port" $exprFile 2>&1 | Out-Null
$styleJson = Get-Content -LiteralPath (Join-Path $pkgRoot 'build\verify-blackbar-after-restart.json') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
Say "computed style / geometry:"
$styleJson -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Say "  $_" }

# geometry of the band region, converted to physical pixels with the live dpr
$probe = $null
try {
  # cdp-eval.mjs writes "target: …", "websocket: connected", "value:" and only then the JSON
  $brace = $styleJson.IndexOf('{')
  if ($brace -ge 0) { $probe = $styleJson.Substring($brace) | ConvertFrom-Json }
} catch { }
if (-not $probe -or -not $probe.band) { Say "FAILED: could not read the band geometry from the page"; exit 1 }
Say ("verdict: {0}" -f $probe.verdict)
Say ("stylesheet rules mentioning the fade: {0}" -f $probe.stylesheetRulesMentioningFade)
$geom = @($probe.band.x, $probe.band.y, $probe.band.w, $probe.band.h, $probe.viewport.Split('x')[1])
Say ("band region (css): x={0} y={1} w={2} h={3} innerHeight={4}" -f $geom)

# --- 2. capture the window and measure the band ------------------------------
& (Join-Path $pkgRoot 'tools\shot-window.ps1') -OutFile $shot 2>&1 | ForEach-Object { Say $_ }
if (-not (Test-Path -LiteralPath $shot)) { Say "FAILED: no capture written"; exit 1 }

$measure = @'
import sys
from PIL import Image
import numpy as np
im = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int)
dpr = float(sys.argv[2])
x, y, w, h, ih = (float(v) for v in sys.argv[3:8])
top = int(round(y * dpr)); bot = int(round((y + h) * dpr))
left = int(round(x * dpr)); right = int(round((x + w) * dpr))
ref = int(round((y - 40) * dpr))          # the same column, above the band
band = im[top:bot, left:right]
above = im[ref:top, left:right]
print("window pixels            :", im.shape[1], "x", im.shape[0], " dpr", dpr)
print("band rect (css->physical):", [x, y, w, h], "->", [left, top, right, bot])
print("band mean RGB            :", band.mean(axis=(0, 1)).round(1), "  (was 46.6/51.2/56.7 with the black bar)")
print("band right edge, last 8px:", band[:, -8:].mean(axis=(0, 1)).round(1), "  (no dark edge -> strip really gone)")
print("background above it      :", above.mean(axis=(0, 1)).round(1))
print("band minus background    :", (band.mean(axis=(0, 1)) - above.mean(axis=(0, 1))).round(1))
'@
$tmpPy = Join-Path $env:TEMP 'measure-band.py'
Set-Content -LiteralPath $tmpPy -Value $measure -Encoding UTF8
& $python $tmpPy $shot $probe.dpr @geom 2>&1 | ForEach-Object { Say "  $_" }
Remove-Item -LiteralPath $tmpPy -Force -ErrorAction SilentlyContinue

Say "capture: $shot"
Say "=== verifier done ==="
