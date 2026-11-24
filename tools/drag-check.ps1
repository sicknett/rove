# Starts the debug build, drags the window by its title bar with the mouse, and reports whether
# it moved. Moves the real mouse for about a second; takes no screenshots.
param([string]$Exe = '', [string]$DataDir = (Join-Path $env:TEMP 'rove-drag-check'), [switch]$TopEdge)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$target = if ($Exe) { $Exe } else { Join-Path $root 'shell\target\debug\rove.exe' }
Add-Type -Namespace Rove -Name Drag -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
public static IntPtr WindowOf(uint pid) {
  IntPtr found = IntPtr.Zero;
  EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64); if (p == pid && c.ToString() == "RoveDesktopWindow") { found = h; return false; } return true; }, IntPtr.Zero);
  return found;
}
public struct RECT { public int Left, Top, Right, Bottom; }
'@
# A separate data folder means a separate copy: an open ROVE is never touched.
$env:ROVE_DATA_DIR = $DataDir
$p = Start-Process -FilePath $target -PassThru
Remove-Item Env:ROVE_DATA_DIR
Start-Sleep -Seconds 6
$h = [Rove.Drag]::WindowOf([uint32]$p.Id)
if ($h -eq [IntPtr]::Zero) { 'test window not found'; Stop-Process -Id $p.Id -Force; return }
$r = New-Object Rove.Drag+RECT
[void][Rove.Drag]::GetWindowRect($h, [ref]$r)
"before: $($r.Left),$($r.Top) size $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"
[void][Rove.Drag]::SetForegroundWindow($h)
$x = $r.Left + [int](($r.Right - $r.Left) * 0.55); $y = if ($TopEdge) { $r.Top + 2 } else { $r.Top + 14 }
[void][Rove.Drag]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 300
[Rove.Drag]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # left down
Start-Sleep -Milliseconds 250
for ($i = 1; $i -le 10; $i++) { [void][Rove.Drag]::SetCursorPos($x - 20 * $i, $y + 8 * $i); Start-Sleep -Milliseconds 30 }
[Rove.Drag]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # left up
Start-Sleep -Milliseconds 400
$r2 = New-Object Rove.Drag+RECT
[void][Rove.Drag]::GetWindowRect($h, [ref]$r2)
"after:  $($r2.Left),$($r2.Top) size $($r2.Right - $r2.Left)x$($r2.Bottom - $r2.Top)"
"moved: $(($r2.Left -ne $r.Left) -or ($r2.Top -ne $r.Top))"
[void][Rove.Drag]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
[void]$p.WaitForExit(6000)
