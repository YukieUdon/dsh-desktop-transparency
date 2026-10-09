param(
  [string]$OutFile = (Join-Path $env:TEMP 'dsh-corner-probe.txt')
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinProbe {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][WinProbe]::SetProcessDPIAware()

$lines = New-Object System.Collections.Generic.List[string]
function Say($s) { $lines.Add($s); $lines | Set-Content -LiteralPath $OutFile -Encoding utf8 }

$p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Say 'no DSH window'; exit 1 }
$hwnd = $p.MainWindowHandle
[void][WinProbe]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 900
$r = New-Object WinProbe+RECT
[void][WinProbe]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Say "window rect: $($r.Left),$($r.Top) ${w}x${h}  dpi-aware"

function Grab([int]$x, [int]$y, [int]$cw, [int]$ch) {
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
  $g.Dispose()
  return $bmp
}

# 1. with the window visible
$shown = Grab $r.Left $r.Top $w $h

# 2. hide the window, grab the very same screen region, show it again
[void][WinProbe]::ShowWindow($hwnd, 0)   # SW_HIDE
Start-Sleep -Milliseconds 700
$behind = Grab $r.Left $r.Top $w $h
[void][WinProbe]::ShowWindow($hwnd, 5)   # SW_SHOW
Start-Sleep -Milliseconds 500

$points = @(
  @{ n = 'corner TL';      x = 3;          y = 3 },
  @{ n = 'corner TR';      x = $w - 4;     y = 3 },
  @{ n = 'corner BL';      x = 3;          y = $h - 4 },
  @{ n = 'corner BR';      x = $w - 4;     y = $h - 4 },
  @{ n = 'inside TL 40';   x = 40;         y = 40 },
  @{ n = 'inside TR 40';   x = $w - 40;    y = 40 },
  @{ n = 'inside BL 40';   x = 40;         y = $h - 40 },
  @{ n = 'inside BR 40';   x = $w - 40;    y = $h - 40 },
  @{ n = 'center';         x = [int]($w/2); y = [int]($h/2) }
)

$max = 0
foreach ($pt in $points) {
  $a = $shown.GetPixel($pt.x, $pt.y)
  $b = $behind.GetPixel($pt.x, $pt.y)
  $d = [Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B)
  if ($d -gt $max) { $max = $d }
  $verdict = if ($d -le 6) { 'transparent' } elseif ($d -ge 25) { 'opaque-ish' } else { 'partly' }
  Say ("{0,-14} window=({1,3},{2,3},{3,3})  behind=({4,3},{5,3},{6,3})  delta={7,3}  {8}" -f `
    $pt.n, $a.R, $a.G, $a.B, $b.R, $b.G, $b.B, $d, $verdict)
}
Say ''
Say 'delta 0-6  = same pixel as when the window is hidden => fully transparent there'
Say 'big delta  = the window paints something there (material or page content)'

$shown.Save((Join-Path (Split-Path -Parent $OutFile) 'dsh-probe-shown.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$behind.Save((Join-Path (Split-Path -Parent $OutFile) 'dsh-probe-behind.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$shown.Dispose(); $behind.Dispose()
Say 'saved probe-shown.png / probe-behind.png'
