# Lists the top-level windows (and their direct children) a running rove.exe owns: class, title, visibility.
Add-Type -Namespace Rove -Name Enum -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
'@
$p = Get-Process rove -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { 'rove is not running'; return }
$lines = [Collections.Generic.List[string]]::new()
$describe = { param($h, $indent)
    $c = [Text.StringBuilder]::new(256); [void][Rove.Enum]::GetClassName($h, $c, 256)
    $t = [Text.StringBuilder]::new(256); [void][Rove.Enum]::GetWindowText($h, $t, 256)
    $lines.Add(("{0}{1} class='{2}' title='{3}' visible={4}" -f $indent, $h, $c, $t, [Rove.Enum]::IsWindowVisible($h)))
}
[void][Rove.Enum]::EnumWindows({ param($h, $l)
    $procId = 0; [void][Rove.Enum]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($procId -eq $p.Id) {
        & $describe $h ''
        [void][Rove.Enum]::EnumChildWindows($h, { param($c, $l2) if ([Rove.Enum]::GetParent($c) -eq $h) { & $describe $c '    ' }; $true }, [IntPtr]::Zero)
    }
    $true
}, [IntPtr]::Zero)
$lines
