// Keeps the window's blur on while it is not focused (Windows only).
// Windows 11 switches system backdrops (backgroundMaterial acrylic/mica) off for inactive windows, so the
// window would turn flat grey whenever another window is clicked. Electron has no SendMessage, so one hidden
// PowerShell helper runs for the life of the app and does the native calls; main.js writes commands to its
// stdin, one per line:
//   nca <hwnd>                     WM_NCACTIVATE(TRUE): DWM keeps drawing the backdrop as if active
//   accent <hwnd> <state> <abgr>   SetWindowCompositionAttribute accent (legacy blur that ignores focus)
//   round <hwnd>                   DWMWA_WINDOW_CORNER_PREFERENCE = round (Windows 11 corners on a frameless window)
// The helper never creates a window or takes focus; it exits when its stdin closes (Electron quitting).
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FvNative {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr res);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct AccentPolicy { public int State; public int Flags; public uint Color; public int AnimationId; }
  [StructLayout(LayoutKind.Sequential)] public struct WinCompAttrData { public int Attribute; public IntPtr Data; public int Size; }
  [DllImport("user32.dll")] public static extern int SetWindowCompositionAttribute(IntPtr h, ref WinCompAttrData d);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  public static void Round(IntPtr h) {
    int pref = 2; // DWMWCP_ROUND
    DwmSetWindowAttribute(h, 33, ref pref, 4); // DWMWA_WINDOW_CORNER_PREFERENCE; a no-op before Windows 11
  }
  public static void NcActivate(IntPtr h) {
    IntPtr r;
    // SMTO_ABORTIFHUNG | SMTO_NORMAL; lParam -1 tells DefWindowProc not to repaint the non-client area
    SendMessageTimeout(h, 0x0086, new IntPtr(1), new IntPtr(-1), 0x0002, 500, out r);
  }
  public static void Accent(IntPtr h, int state, uint color) {
    var a = new AccentPolicy { State = state, Flags = 2, Color = color, AnimationId = 0 };
    int size = Marshal.SizeOf(a);
    IntPtr p = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(a, p, false);
      var d = new WinCompAttrData { Attribute = 19, Data = p, Size = size }; // WCA_ACCENT_POLICY
      SetWindowCompositionAttribute(h, ref d);
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Trim().Split(' ')
  try {
    $h = [IntPtr][Int64]$p[1]
    if (-not [FvNative]::IsWindow($h)) { continue }
    switch ($p[0]) {
      'nca'    { [FvNative]::NcActivate($h) }
      'accent' { [FvNative]::Accent($h, [int]$p[2], [Convert]::ToUInt32($p[3], 16)) }
      'round'  { [FvNative]::Round($h) }
    }
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
}
`;

// the HWND as a decimal string, from BrowserWindow.getNativeWindowHandle()
function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString();
}

function startHelper() {
  if (process.platform !== 'win32') return null;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let child;
  try {
    child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch { return null; }
  let alive = true;
  child.on('error', () => { alive = false; });
  child.on('exit', () => { alive = false; });
  child.stdin.on('error', () => { alive = false; });
  return {
    send(line) { if (alive) { try { child.stdin.write(line + '\n'); } catch { alive = false; } } },
    stop() { alive = false; try { child.stdin.end(); } catch {} try { child.kill(); } catch {} },
  };
}

module.exports = { startHelper, hwndOf };
