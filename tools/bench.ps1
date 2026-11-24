# Measures scrolling on Home in the real app (debug build), on a copy of this PC's ROVE setup so
# an open ROVE is never touched. Compares the opaque page (normal) with the see-through page used
# during playback. Shows a window for about half a minute.
param([int]$Port = 9333, [int]$Seconds = 6)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $env:TEMP 'rove-bench'
if (Test-Path $data) { Remove-Item $data -Recurse -Force }
New-Item -ItemType Directory -Force $data | Out-Null
foreach ($d in 'store', 'secrets') {
    $src = Join-Path $env:LOCALAPPDATA "ROVE\$d"
    if (Test-Path $src) { Copy-Item $src (Join-Path $data $d) -Recurse }
}
$env:ROVE_DATA_DIR = $data
$env:ROVE_DEBUG_PORT = "$Port"
$p = Start-Process -FilePath (Join-Path $root 'shell\target\debug\rove.exe') -ArgumentList '--muted' -PassThru
Remove-Item Env:ROVE_DATA_DIR, Env:ROVE_DEBUG_PORT
try {
    Start-Sleep -Seconds 14
    '--- opaque page (normal browsing)'
    node (Join-Path $PSScriptRoot 'scroll-bench.mjs') $Port $Seconds
    '--- see-through page (as during playback, the old default)'
    node --input-type=module -e "const t=await (await fetch('http://127.0.0.1:$Port/json')).json(); const w=new WebSocket(t.find(x=>x.url.includes('rove.localhost')).webSocketDebuggerUrl); await new Promise(r=>w.onopen=r); w.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'window.rove.send({t:\'video\',visible:true})'}})); await new Promise(r=>setTimeout(r,800)); w.close();"
    node (Join-Path $PSScriptRoot 'scroll-bench.mjs') $Port $Seconds
}
finally {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
