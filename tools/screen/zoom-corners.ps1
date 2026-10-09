param(
  [string]$Source = (Join-Path $env:TEMP 'dsh-window-shot.png'),
  [string]$OutFile = (Join-Path $env:TEMP 'dsh-corners-zoom.png'),
  [int]$Crop = 90,
  [int]$Zoom = 5
)

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile($Source)
$w = $src.Width
$h = $src.Height
$c = [Math]::Min($Crop, [Math]::Min($w, $h))
$zw = $c * $Zoom
$gap = 12

# one row: top-left, top-right, bottom-left, bottom-right
$out = New-Object System.Drawing.Bitmap ($zw * 4 + $gap * 5), ($zw + $gap * 2)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.Clear([System.Drawing.Color]::Magenta)   # magenta shows where the crop is transparent-ish
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half

$positions = @(
  @{ x = 0; y = 0 },                # top-left
  @{ x = $w - $c; y = 0 },          # top-right
  @{ x = 0; y = $h - $c },          # bottom-left
  @{ x = $w - $c; y = $h - $c }     # bottom-right
)
$labels = @('top-left', 'top-right', 'bottom-left', 'bottom-right')
for ($i = 0; $i -lt 4; $i++) {
  $p = $positions[$i]
  $rectSrc = New-Object System.Drawing.Rectangle $p.x, $p.y, $c, $c
  $rectDst = New-Object System.Drawing.Rectangle (($i * ($zw + $gap)) + $gap), $gap, $zw, $zw
  $g.DrawImage($src, $rectDst, $rectSrc, [System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString($labels[$i], (New-Object System.Drawing.Font('Segoe UI', 11)), [System.Drawing.Brushes]::White, (($i * ($zw + $gap)) + $gap), 1)
}
$g.Dispose()
$out.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
$src.Dispose()
Write-Output "saved $OutFile  (source $w x $h, crop ${c}px, zoom ${Zoom}x)"
