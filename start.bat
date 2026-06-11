@echo off
rem start.bat - live capture wallpaper. Self-elevates (pktmon needs admin).
net session >nul 2>&1
if errorlevel 1 (
    echo requesting administrator rights for packet capture...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"

if not exist PacketHighway.exe call build.bat
if errorlevel 1 (
    pause
    exit /b 1
)

rem stop any previous instance
taskkill /im PacketHighway.exe /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wallpaper.ps1" -Restore >nul 2>&1

start "" /min PacketHighway.exe

rem wait for the server to come up
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',8339)).Close();exit 0}catch{Start-Sleep -m 250}};exit 1"
if errorlevel 1 (echo server failed to start & pause & exit /b 1)

rem watchdog mode: attaches now, then keeps re-pinning if Edge pops out
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0wallpaper.ps1" -Watch
