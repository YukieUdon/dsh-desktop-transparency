param(
  [string]$OutFile = (Join-Path $env:TEMP 'dsh-window-shot-top.png'),
  [string]$ProcessName = 'DeepSeek Harness'
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CapTop {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][CapTop]::SetProcessDPIAware()
$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no window'; exit 1 }
$h = $p.MainWindowHandle
# Raise above everything for the shot: SetForegroundWindow alone is refused by Windows
# when the caller does not own the foreground, which is how a stale capture happens.
$SWP = 0x0001 -bor 0x0002   # NOSIZE | NOMOVE
[void][CapTop]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, $SWP)
[void][CapTop]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1500
$r = New-Object CapTop+RECT
[void][CapTop]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Output "window $w x $ht at ($($r.Left),$($r.Top))"
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
$g.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[void][CapTop]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, $SWP)   # NOTOPMOST
Write-Output "saved $OutFile"
