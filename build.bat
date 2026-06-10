@echo off
rem build.bat — compile the backend with the C# compiler that ships with Windows
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
"%CSC%" /nologo /optimize /target:exe /out:"%~dp0PacketHighway.exe" /r:System.Drawing.dll "%~dp0PacketHighway.cs"
if errorlevel 1 (echo BUILD FAILED & exit /b 1)
echo built PacketHighway.exe
