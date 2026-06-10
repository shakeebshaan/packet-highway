@echo off
rem start-demo.bat — synthetic traffic, no admin needed, opens in a normal browser tab
cd /d "%~dp0"
if not exist PacketHighway.exe call build.bat
if errorlevel 1 (
    pause
    exit /b 1
)
taskkill /im PacketHighway.exe /f >nul 2>&1
start "" /min PacketHighway.exe --demo
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',8339)).Close();exit 0}catch{Start-Sleep -m 250}}"
start "" http://localhost:8339/
