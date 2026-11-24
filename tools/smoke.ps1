# Starts the debug build muted with a sample stream, lets it play, closes it, and prints the log.
# Checks that the window opens, the page loads, mpv starts and the stream plays and stops cleanly.
param([int]$Seconds = 20, [string]$Exe = '', [string]$Url = 'https://archive.org/download/Sintel/sintel-2048-surround.mp4')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$target = if ($Exe) { $Exe } else { Join-Path $root 'shell\target\debug\rove.exe' }
$log = Join-Path $env:LOCALAPPDATA 'ROVE\logs\rove.log'
$before = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
$p = Start-Process -FilePath $target -ArgumentList @('--play', $Url, '--muted') -PassThru
Start-Sleep -Seconds $Seconds
$alive = -not $p.HasExited
$cpu = if ($alive) { [Math]::Round($p.TotalProcessorTime.TotalSeconds, 1) } else { $null }
$mem = if ($alive) { [Math]::Round($p.WorkingSet64 / 1MB) } else { $null }
Add-Type -Namespace Rove -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
'@
if ($alive) {
    $hwnd = [Rove.Win]::FindWindow('RoveDesktopWindow', [NullString]::Value)
    "main window found: $($hwnd -ne [IntPtr]::Zero)"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [void][Rove.Win]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
    if ($p.WaitForExit(8000)) { "closed in $($sw.ElapsedMilliseconds) ms" } else { Stop-Process -Id $p.Id -Force; 'had to force-stop' }
}
"alive after ${Seconds}s: $alive  cpu: ${cpu}s  working set: ${mem} MB  exit code: $($p.ExitCode)"
'--- log (this run) ---'
$fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); [void]$fs.Seek($before, 'Begin')
$reader = [IO.StreamReader]::new($fs); $reader.ReadToEnd(); $reader.Dispose()
