# Помощник оверлея: определяет активное окно и его размер.
# Живёт одним процессом и отвечает строкой JSON на каждую строку stdin —
# так не нужно запускать PowerShell по несколько раз в секунду.
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ArcFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $result = @{ ok = $false; pid = 0; name = ''; title = ''; x = 0; y = 0; w = 0; h = 0; fullscreen = $false; desktop = $false; maximized = $false }
  try {
    $hwnd = [ArcFg]::GetForegroundWindow()
    $shell = [ArcFg]::GetShellWindow()
    $result.desktop = ($hwnd -eq [IntPtr]::Zero) -or ($hwnd -eq $shell)
    $procId = 0
    [void][ArcFg]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    $result.pid = $procId
    $proc = $null
    try { $proc = Get-Process -Id $procId -ErrorAction Stop } catch { }
    if ($proc) {
      $result.name = [string]$proc.ProcessName
      try { $result.title = [string]$proc.MainWindowTitle } catch { }
    }
    $rect = New-Object ArcFg+RECT
    if ([ArcFg]::GetWindowRect($hwnd, [ref]$rect)) {
      $result.x = [int]$rect.Left
      $result.y = [int]$rect.Top
      $result.w = [int]($rect.Right - $rect.Left)
      $result.h = [int]($rect.Bottom - $rect.Top)
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $result.fullscreen = ($result.x -le $screen.X) -and ($result.y -le $screen.Y) `
        -and ($result.w -ge $screen.Width) -and ($result.h -ge $screen.Height)
    }
    try { $result.maximized = [ArcFg]::IsZoomed($hwnd) } catch { }
    $result.ok = $true
  } catch {
    $result.error = [string]$_.Exception.Message
  }
  $out.WriteLine(($result | ConvertTo-Json -Compress))
}
