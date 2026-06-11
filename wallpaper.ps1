# wallpaper.ps1 - pins Packet Highway (an Edge app window) into the desktop's
# WorkerW layer so it renders as a live wallpaper behind desktop icons.
# Handles classic + Win11 24H2 desktop layouts, mixed-DPI multi-monitor.
#   -Watch   : keep running and re-pin/relaunch automatically (recommended)
#   -Span    : stretch across all monitors (default: primary only)
#   -Restore : detach + close the wallpaper and the watchdog
param(
    [string]$Url = "http://localhost:8339/?wallpaper=1",
    [switch]$Restore,
    [switch]$Span,
    [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot ".wallpaper.pid"
$watchPidFile = Join-Path $PSScriptRoot ".wallpaper.watch.pid"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class WP
{
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int val);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint p, string lp, uint ini);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    public delegate bool EnumProc(IntPtr h, IntPtr lp);

    public static List<IntPtr> All()
    {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
    public static string Title(IntPtr h) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
    public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

    // PowerShell coerces $null to "" on [string] parameters, which breaks
    // FindWindow(class, null). Keep all null-string calls on the C# side.
    public static IntPtr Progman() { return FindWindow("Progman", null); }
    public static IntPtr ChildByClass(IntPtr parent, IntPtr after, string cls) { return FindWindowEx(parent, after, cls, null); }

    public static IntPtr FindWallpaperHost()
    {
        IntPtr progman = Progman();
        IntPtr res;
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, 0, 1000, out res);
        SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), 0, 1000, out res);

        // classic layout: WorkerW is the top-level sibling after the WorkerW
        // that owns SHELLDLL_DefView
        foreach (IntPtr h in All())
        {
            if (Cls(h) != "WorkerW") continue;
            if (ChildByClass(h, IntPtr.Zero, "SHELLDLL_DefView") == IntPtr.Zero) continue;
            IntPtr w = FindWindowEx(IntPtr.Zero, h, "WorkerW", null);
            if (w != IntPtr.Zero) return w;
        }
        // Win11 24H2 layout: SHELLDLL_DefView and WorkerW both live under Progman
        IntPtr ww = ChildByClass(progman, IntPtr.Zero, "WorkerW");
        if (ww != IntPtr.Zero) return ww;
        return progman;
    }

    // find our Edge window whether it's top-level (detached) or already a
    // child of a wallpaper host window (attached)
    public static IntPtr FindPHWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (Cls(h) == "Chrome_WidgetWin_1" && Title(h).Contains("PacketHighway")) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        if (found != IntPtr.Zero) return found;
        foreach (IntPtr top in All())
        {
            string c = Cls(top);
            if (c != "WorkerW" && c != "Progman") continue;
            IntPtr f2 = IntPtr.Zero;
            EnumChildWindows(top, (h, l) =>
            {
                if (Cls(h) == "Chrome_WidgetWin_1" && Title(h).Contains("PacketHighway")) { f2 = h; return false; }
                return true;
            }, IntPtr.Zero);
            if (f2 != IntPtr.Zero) return f2;
        }
        return IntPtr.Zero;
    }
}
"@

# without this, all window coordinates arrive DPI-virtualized and the
# wallpaper gets sized/placed wrong on scaled or multi-monitor setups
[WP]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null  # per-monitor v2

function Stop-WallpaperEdges {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like '*PacketHighwayWallpaper*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction Stop } catch {} }
}

if ($Restore) {
    if (Test-Path $watchPidFile) {
        try { Stop-Process -Id (Get-Content $watchPidFile) -Force -Confirm:$false -ErrorAction Stop } catch {}
        Remove-Item $watchPidFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $pidFile) {
        try { Stop-Process -Id (Get-Content $pidFile) -Force -Confirm:$false -ErrorAction Stop } catch {}
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    Stop-WallpaperEdges
    # nudge the desktop to repaint the static wallpaper
    $wp = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name WallPaper -ErrorAction SilentlyContinue).WallPaper
    if ($wp) { [WP]::SystemParametersInfo(20, 0, $wp, 3) | Out-Null }
    Write-Host "wallpaper removed"
    exit 0
}

function Start-WallpaperEdge {
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
              "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $edge) { throw "Microsoft Edge not found" }
    $profileDir = Join-Path $env:LOCALAPPDATA "PacketHighwayWallpaper"
    Start-Process $edge -ArgumentList @(
        "--app=$Url",
        "--user-data-dir=`"$profileDir`"",
        "--no-first-run", "--disable-background-mode",
        # a wallpaper window is permanently "occluded" - stop Chromium throttling it
        "--disable-features=msEdgeSidebarV2,CalculateNativeWinOcclusion",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling"
    )
}

function Set-WallpaperPlacement([IntPtr]$hwnd, [IntPtr]$hostW) {
    $vx = [WP]::GetSystemMetrics(76); $vy = [WP]::GetSystemMetrics(77)   # virtual origin
    if ($Span) {
        $x = 0; $y = 0
        $w = [WP]::GetSystemMetrics(78); $h2 = [WP]::GetSystemMetrics(79) # virtual size
        $r = New-Object -TypeName 'WP+RECT'
        if ([WP]::GetClientRect($hostW, [ref]$r) -and ($r.R - $r.L) -gt 100) { $w = $r.R - $r.L; $h2 = $r.B - $r.T }
    } else {
        # primary monitor only (its top-left is physical 0,0)
        $x = -$vx; $y = -$vy
        $w = [WP]::GetSystemMetrics(0); $h2 = [WP]::GetSystemMetrics(1)
    }
    [WP]::MoveWindow($hwnd, $x, $y, $w, $h2, $true) | Out-Null
    return "${w}x${h2} at $x,$y"
}

function Attach-Window([IntPtr]$hwnd) {
    $GWL_STYLE = -16; $GWL_EXSTYLE = -20
    $WS_CHILD = 0x40000000; $WS_POPUP = 0x80000000; $WS_CAPTION_THICK = 0x00C40000
    for ($try = 0; $try -lt 5; $try++) {
        $hostW = [WP]::FindWallpaperHost()
        if (-not [WP]::IsWindow($hostW)) { Start-Sleep -Milliseconds 400; continue }

        # SetParent does not adjust styles itself: drop popup/caption, add WS_CHILD first
        $style = [WP]::GetWindowLong($hwnd, $GWL_STYLE)
        $style = ($style -band (-bnot ($WS_CAPTION_THICK -bor $WS_POPUP))) -bor $WS_CHILD
        [WP]::SetWindowLong($hwnd, $GWL_STYLE, $style) | Out-Null
        $ex = [WP]::GetWindowLong($hwnd, $GWL_EXSTYLE)
        [WP]::SetWindowLong($hwnd, $GWL_EXSTYLE, ($ex -bor 0x80)) | Out-Null # WS_EX_TOOLWINDOW

        [WP]::SetParent($hwnd, $hostW) | Out-Null
        Start-Sleep -Milliseconds 250
        if ([WP]::GetParent($hwnd) -eq $hostW) {
            $size = Set-WallpaperPlacement $hwnd $hostW
            return @{ ok = $true; host = $hostW; size = $size }
        }
        Start-Sleep -Milliseconds 400
    }
    return @{ ok = $false }
}

function Test-Attached([IntPtr]$hwnd) {
    if (-not [WP]::IsWindow($hwnd)) { return $false }
    $par = [WP]::GetParent($hwnd)
    if ($par -eq [IntPtr]::Zero) { return $false }
    $cls = [WP]::Cls($par)
    return ($cls -eq 'WorkerW' -or $cls -eq 'Progman')
}

function Ensure-Backend {
    if (-not (Get-Process PacketHighway -ErrorAction SilentlyContinue)) {
        $exe = Join-Path $PSScriptRoot 'PacketHighway.exe'
        if (Test-Path $exe) {
            Start-Process -WindowStyle Hidden -FilePath $exe
            Start-Sleep -Seconds 2
            Write-Host ("backend restarted at " + (Get-Date -Format HH:mm:ss))
        }
    }
}

# find an existing window, or launch Edge and wait for one
function Ensure-Wallpaper([bool]$quiet) {
    $hwnd = [WP]::FindPHWindow()
    if ($hwnd -eq [IntPtr]::Zero) {
        if (-not $quiet) { Write-Host "launching Edge..." }
        Start-WallpaperEdge
        for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) {
            Start-Sleep -Milliseconds 500
            $hwnd = [WP]::FindPHWindow()
        }
        if ($hwnd -eq [IntPtr]::Zero) { throw "could not find the Edge app window (is the server running on $Url ?)" }
        Start-Sleep -Milliseconds 1200 # let the real window settle
        $h2 = [WP]::FindPHWindow(); if ($h2 -ne [IntPtr]::Zero) { $hwnd = $h2 }
    }
    if (-not (Test-Attached $hwnd)) {
        $res = Attach-Window $hwnd
        if (-not $res.ok) { throw "could not attach the window to the desktop wallpaper layer" }
        $p = [uint32]0; [WP]::GetWindowThreadProcessId($hwnd, [ref]$p) | Out-Null
        Set-Content $pidFile $p
        if (-not $quiet) {
            $where = if ($Span) { "all monitors" } else { "primary monitor" }
            Write-Host "Packet Highway pinned to the $where ($($res.size), host $($res.host))"
        } else {
            Write-Host ("re-pinned at " + (Get-Date -Format HH:mm:ss))
        }
    }
    return $hwnd
}

Ensure-Backend
Ensure-Wallpaper $false | Out-Null
if ($Watch) {
    $PID | Set-Content $watchPidFile
    Write-Host "watchdog active (pid $PID) - re-pins automatically; stop.bat to end"
    while ($true) {
        Start-Sleep -Seconds 5
        try { Ensure-Backend; Ensure-Wallpaper $true | Out-Null } catch { }
    }
}
Write-Host "run stop.bat (or wallpaper.ps1 -Restore) to remove it; use -Span for all monitors"
