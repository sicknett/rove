# Prints each installed addon's catalogs (name, type, id, extras, showInHome) from ROVE's
# encrypted addon list. Never prints addon links, which can hold configuration secrets.
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'ROVE'))
Add-Type -AssemblyName System.Security
$bin = Join-Path $DataDir 'secrets\addons.bin'
$bytes = [IO.File]::ReadAllBytes($bin)
$entropy = [Text.Encoding]::ASCII.GetBytes('ROVE desktop secrets v1')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, 'CurrentUser')
$doc = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
foreach ($a in $doc.addons) {
    $m = $a.manifest
    $res = ($m.resources | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.name } }) -join ','
    "== $($m.name) ($($m.id)) enabled=$($a.enabled) resources=[$res] types=[$($m.types -join ',')] idPrefixes=[$($m.idPrefixes -join ',')] catalogs=$($m.catalogs.Count)"
    foreach ($c in $m.catalogs) {
        $extras = ($c.extra | ForEach-Object { "$($_.name)$(if ($_.isRequired) { '*' })" }) -join ','
        if (-not $extras -and $c.extraSupported) { $extras = 'old:' + ($c.extraSupported -join ',') + ' req:' + ($c.extraRequired -join ',') }
        "   [$($c.type)] $($c.name)  id=$($c.id)  extra=[$extras]  showInHome=$($c.showInHome)"
    }
}
