# Builds the app icon (.ico) and web-sized logo images from assets\brand.
# Run from anywhere: powershell -ExecutionPolicy Bypass -File tools\make-brand-assets.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$brand = Join-Path $root 'assets\brand'

function Get-AlphaBounds([System.Drawing.Bitmap]$bmp, [int]$threshold = 8) {
    $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
    $rect = [System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $bmp.Height)
    $data = $bmp.LockBits($rect, 'ReadOnly', [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = New-Object byte[] ($data.Stride * $bmp.Height)
    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($data)
    for ($y = 0; $y -lt $bmp.Height; $y++) {
        $row = $y * $data.Stride
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            if ($bytes[$row + $x * 4 + 3] -gt $threshold) {
                if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    [System.Drawing.Rectangle]::new($minX, $minY, $maxX - $minX + 1, $maxY - $minY + 1)
}

function Save-Resized([System.Drawing.Image]$img, [System.Drawing.Rectangle]$crop, [int]$maxWidth, [string]$path) {
    $scale = [Math]::Min(1.0, $maxWidth / $crop.Width)
    $w = [int][Math]::Round($crop.Width * $scale); $h = [int][Math]::Round($crop.Height * $scale)
    $out = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
    $g.DrawImage($img, [System.Drawing.Rectangle]::new(0, 0, $w, $h), $crop, 'Pixel')
    $g.Dispose(); $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $out.Dispose()
    "$path ${w}x$h"
}

# Web logos (transparent, cropped): full logo for dark backgrounds, and the mark alone.
$webDir = Join-Path $root 'ui\src\assets'
New-Item -ItemType Directory -Force $webDir | Out-Null
$logo = [System.Drawing.Bitmap]::new((Join-Path $brand 'logo-sage-white-text.png'))
$bounds = Get-AlphaBounds $logo
Save-Resized $logo $bounds 1100 (Join-Path $webDir 'rove-logo.png')
# The mark ends where the gap before the R starts: scan columns for the first fully clear run.
$markRight = $bounds.X
$rect = [System.Drawing.Rectangle]::new(0, 0, $logo.Width, $logo.Height)
$data = $logo.LockBits($rect, 'ReadOnly', [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $logo.Height); [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length); $logo.UnlockBits($data)
$clearRun = 0
for ($x = $bounds.X; $x -lt $bounds.Right; $x++) {
    $any = $false
    for ($y = $bounds.Y; $y -lt $bounds.Bottom; $y += 2) { if ($bytes[$y * $data.Stride + $x * 4 + 3] -gt 8) { $any = $true; break } }
    if ($any) { $markRight = $x; $clearRun = 0 } else { $clearRun++; if ($clearRun -gt 20) { break } }
}
$markCrop = [System.Drawing.Rectangle]::new($bounds.X, $bounds.Y, $markRight - $bounds.X + 1, $bounds.Height)
Save-Resized $logo $markCrop 400 (Join-Path $webDir 'rove-mark.png')
$logo.Dispose()

$wall = [System.Drawing.Bitmap]::new((Join-Path $brand 'wallpaper-dark.png'))
Save-Resized $wall ([System.Drawing.Rectangle]::new(0, 0, $wall.Width, $wall.Height)) 1920 (Join-Path $webDir 'wallpaper.png')
$wall.Dispose()

# App icon: PNG-compressed entries in one .ico.
$icon = [System.Drawing.Bitmap]::new((Join-Path $brand 'app-icon.png'))
$iconBounds = Get-AlphaBounds $icon
$side = [Math]::Max($iconBounds.Width, $iconBounds.Height)
$square = [System.Drawing.Rectangle]::new($iconBounds.X - [int](($side - $iconBounds.Width) / 2), $iconBounds.Y - [int](($side - $iconBounds.Height) / 2), $side, $side)
$sizes = 16, 20, 24, 32, 40, 48, 64, 96, 128, 256
$entries = foreach ($s in $sizes) {
    $bmp = [System.Drawing.Bitmap]::new($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'HighQuality'
    $g.DrawImage($icon, [System.Drawing.Rectangle]::new(0, 0, $s, $s), $square, 'Pixel'); $g.Dispose()
    $ms = [IO.MemoryStream]::new(); $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    [pscustomobject]@{ Size = $s; Bytes = $ms.ToArray() }
}
$icoPath = Join-Path $root 'shell\icons\rove.ico'
$fs = [IO.File]::Create($icoPath); $bw = [IO.BinaryWriter]::new($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$e.Bytes.Length); $bw.Write([uint32]$offset)
    $offset += $e.Bytes.Length
}
foreach ($e in $entries) { $bw.Write($e.Bytes) }
$bw.Dispose(); $fs.Dispose()
Save-Resized $icon $square 256 (Join-Path $webDir 'rove-icon.png')
$icon.Dispose()
"$icoPath $((Get-Item $icoPath).Length) bytes"
