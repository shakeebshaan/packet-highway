# relaunch-live.ps1 - run elevated: restarts the backend in live-capture mode
taskkill /im PacketHighway.exe /f 2>$null
Start-Sleep -Seconds 1
if (Test-Path (Join-Path $PSScriptRoot 'PacketHighway.new.exe')) { Move-Item -Force (Join-Path $PSScriptRoot 'PacketHighway.new.exe') (Join-Path $PSScriptRoot 'PacketHighway.exe') }
Start-Process -WindowStyle Minimized -FilePath (Join-Path $PSScriptRoot 'PacketHighway.exe')
