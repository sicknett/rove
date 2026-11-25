# Builds ROVE for release and lays it out as a portable app in dist\ROVE:
#   rove.exe, libmpv-2.dll, web\ (the page). Then adds Start menu and Desktop shortcuts.
# The app must not be running (its files are replaced). -NoShortcuts skips the shortcuts.
param([switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'dist\ROVE'

# Only a copy running from this output folder blocks the build; an installed ROVE can stay open.
if (Get-Process rove -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($out, [StringComparison]::OrdinalIgnoreCase) }) { throw 'The ROVE in dist\ROVE is running; close it first.' }

Push-Location (Join-Path $root 'ui')
try { npm run build | Out-Host; if ($LASTEXITCODE) { throw 'page build failed' } } finally { Pop-Location }
Push-Location (Join-Path $root 'shell')
try { cargo build --release | Out-Host; if ($LASTEXITCODE) { throw 'shell build failed' } } finally { Pop-Location }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $root 'shell\target\release\rove.exe') $out
Copy-Item (Join-Path $root 'vendor\mpv\libmpv-2.dll') $out
Copy-Item (Join-Path $root 'ui\dist') (Join-Path $out 'web') -Recurse

if (-not $NoShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $targets = @(
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'ROVE.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ROVE.lnk')
    )
    foreach ($lnk in $targets) {
        $s = $shell.CreateShortcut($lnk)
        $s.TargetPath = Join-Path $out 'rove.exe'
        $s.WorkingDirectory = $out
        $s.IconLocation = "$(Join-Path $out 'rove.exe'),0"
        $s.Description = 'ROVE'
        $s.Save()
        "shortcut: $lnk"
    }
}
Get-ChildItem $out | Select-Object Name, Length | Format-Table -AutoSize | Out-String
