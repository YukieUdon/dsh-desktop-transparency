param(
  [string]$OutFile = (Join-Path $env:TEMP 'dsh-window-shot.png'),
  [string]$ProcessName = 'DeepSeek Harness',
  [string]$TitleLike = ''
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# Without this the process reports virtualized (logical) window rects while screen
# capture works in physical pixels, so the capture lands offset on a scaled display.
[void][WinCap]::SetProcessDPIAware()

$candidates = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 })
if ($TitleLike) { $candidates = @($candidates | Where-Object { $_.MainWindowTitle -like "*$TitleLike*" }) }
$p = $candidates | Select-Object -First 1
if (-not $p) { Write-Output "no window for process '$ProcessName' title like '$TitleLike'"; exit 1 }

[void][WinCap]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 1200
$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output "window '$($p.MainWindowTitle)' $w x $h at ($($r.Left),$($r.Top))"

# Capture the screen area the window occupies. A transparent window lets whatever
# sits behind it show through inside this rectangle, which is exactly how a rounded
# window shape can be verified.
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $OutFile"
