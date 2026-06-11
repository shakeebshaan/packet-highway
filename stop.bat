@echo off
rem stop.bat - remove the wallpaper, stop capture and the server
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wallpaper.ps1" -Restore
taskkill /im PacketHighway.exe /f >nul 2>&1
pktmon stop >nul 2>&1
echo stopped.
