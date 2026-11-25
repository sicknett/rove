# Builds ROVE and wraps it in an installer: dist\ROVE-Setup-<version>.exe
# Needs Inno Setup 6 (winget install JRSoftware.InnoSetup). ROVE must not be running.
# The version comes from shell\Cargo.toml.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$iscc = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 is not installed (winget install JRSoftware.InnoSetup).' }

$version = (Select-String -Path (Join-Path $root 'shell\Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value

# The app itself, without the development shortcuts (the installer makes its own).
& (Join-Path $PSScriptRoot 'package.ps1') -NoShortcuts | Out-Host

# Wizard art: the app's mark on the dark brand wallpaper, and the app icon.
$images = Join-Path $root 'installer\build'
New-Item -ItemType Directory -Force $images | Out-Null
Add-Type -AssemblyName System.Drawing
function Save-Art([string]$path, [int]$w, [int]$h, [scriptblock]$draw) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.SmoothingMode = 'HighQuality'
    & $draw $g
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
}
$brand = Join-Path $root 'assets\brand'
$wall = [System.Drawing.Image]::FromFile((Join-Path $brand 'wallpaper-dark.png'))
$mark = [System.Drawing.Image]::FromFile((Join-Path $root 'ui\src\assets\rove-mark.png'))
$icon = [System.Drawing.Image]::FromFile((Join-Path $brand 'app-icon.png'))
try {
    # 2x the 164x314 the wizard uses at 100 %, so it stays sharp on scaled displays.
    Save-Art (Join-Path $images 'wizard-large.bmp') 328 628 {
        param($g)
        $scale = 628 / $wall.Height
        $sw = [int]($wall.Width * $scale)
        $g.DrawImage($wall, [int]((328 - $sw) / 2), 0, $sw, 628)
        # The app's sage mark (400x418), centred.
        $g.DrawImage($mark, 89, 220, 150, 157)
    }
    Save-Art (Join-Path $images 'wizard-small.bmp') 110 110 {
        param($g)
        $g.Clear([System.Drawing.Color]::FromArgb(15, 16, 17))
        $g.DrawImage($icon, 0, 0, 110, 110)
    }
} finally {
    $wall.Dispose(); $mark.Dispose(); $icon.Dispose()
}

$dist = Join-Path $root 'dist'
& $iscc /Q `
    "/DAppVersion=$version" `
    "/DSourceDir=$(Join-Path $dist 'ROVE')" `
    "/DOutputDir=$dist" `
    "/DImagesDir=$images" `
    "/DIconFile=$(Join-Path $root 'shell\icons\rove.ico')" `
    (Join-Path $root 'installer\rove.iss')
if ($LASTEXITCODE) { throw "installer build failed ($LASTEXITCODE)" }

$setup = Get-Item (Join-Path $dist "ROVE-Setup-$version.exe")
"installer: $($setup.FullName)  ($([Math]::Round($setup.Length / 1MB)) MB)"
