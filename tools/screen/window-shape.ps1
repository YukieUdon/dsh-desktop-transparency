param(
  [ValidateSet('probe', 'dwm', 'rgn', 'dwm+rgn', 'clear')]
  [string]$Mode = 'probe',
  [int]$Radius = 16,
  [string]$ProcessName = 'DeepSeek Harness',
  [string]$TitleLike = '',
  [string]$OutFile = (Join-Path $env:TEMP 'dsh-corner-treatment.txt')
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinShape {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[void][WinShape]::SetProcessDPIAware()

$lines = New-Object System.Collections.Generic.List[string]
function Say($s) { $lines.Add($s); $lines | Set-Content -LiteralPath $OutFile -Encoding utf8 }

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 })
if ($TitleLike) { $procs = @($procs | Where-Object { $_.MainWindowTitle -like "*$TitleLike*" }) }
if ($procs.Count -eq 0) { Say "no window found for process '$ProcessName' title like '$TitleLike'"; exit 1 }

foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  $r = New-Object WinShape+RECT
  [void][WinShape]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  Say ("window '{0}' pid={1} hwnd={2} rect={3},{4} {5}x{6}" -f $p.MainWindowTitle, $p.Id, $h, $r.Left, $r.Top, $w, $ht)

  $ex = [WinShape]::GetWindowLong($h, -20)   # GWL_EXSTYLE
  $style = [WinShape]::GetWindowLong($h, -16) # GWL_STYLE
  $layered = ($ex -band 0x00080000) -ne 0
  $wsPopup = ($style -band 0x80000000) -ne 0
  Say ("  exstyle=0x{0:X8} style=0x{1:X8} WS_EX_LAYERED={2} WS_POPUP={3}" -f $ex, $style, $layered, $wsPopup)

  $pref = -1
  [void][WinShape]::DwmGetWindowAttribute($h, 33, [ref]$pref, 4)  # DWMWA_WINDOW_CORNER_PREFERENCE
  Say ("  DWMWA_WINDOW_CORNER_PREFERENCE before = $pref  (0=default 1=donotround 2=round 3=roundsmall)")

  switch ($Mode) {
    'dwm' {
      $want = 2
      $rc = [WinShape]::DwmSetWindowAttribute($h, 33, [ref]$want, 4)
      Say ("  DwmSetWindowAttribute(ROUND) -> hr=0x{0:X8}" -f $rc)
    }
    'rgn' {
      $rgnRadius = [int]($Radius * 1.5)   # CSS px -> physical px at 150%
      $rgn = [WinShape]::CreateRoundRectRgn(0, 0, $w + 1, $ht + 1, $rgnRadius * 2, $rgnRadius * 2)
      $ok = [WinShape]::SetWindowRgn($h, $rgn, $true)
      Say ("  SetWindowRgn(round r=$rgnRadius) ok=$ok")
    }
    'dwm+rgn' {
      $want = 2
      [void][WinShape]::DwmSetWindowAttribute($h, 33, [ref]$want, 4)
      $rgnRadius = [int]($Radius * 1.5)
      $rgn = [WinShape]::CreateRoundRectRgn(0, 0, $w + 1, $ht + 1, $rgnRadius * 2, $rgnRadius * 2)
      $ok = [WinShape]::SetWindowRgn($h, $rgn, $true)
      Say ("  DWM preference set to ROUND and SetWindowRgn(r=$rgnRadius) ok=$ok")
    }
    'clear' {
      $want = 1
      [void][WinShape]::DwmSetWindowAttribute($h, 33, [ref]$want, 4)
      [void][WinShape]::SetWindowRgn($h, [IntPtr]::Zero, $true)
      Say '  cleared corner preference and window region'
    }
  }

  if ($Mode -ne 'probe') {
    $after = -1
    [void][WinShape]::DwmGetWindowAttribute($h, 33, [ref]$after, 4)
    Say ("  DWMWA_WINDOW_CORNER_PREFERENCE after = $after")
  }
}
Say 'done'
