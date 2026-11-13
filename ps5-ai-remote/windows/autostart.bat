@echo off
chcp 65001 >nul
rem Starts the remote automatically (minimized) every time you log in to Windows.
set "TARGET=%~dp0start.bat"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PS5 AI Remote.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath=$env:TARGET; $s.WorkingDirectory=(Split-Path $env:TARGET); $s.WindowStyle=7; $s.Save()"
if exist "%LINK%" (echo Done: the remote will start when Windows starts.) else (echo Failed to create the startup shortcut.)
pause
