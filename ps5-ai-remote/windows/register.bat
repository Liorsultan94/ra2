@echo off
chcp 65001 >nul
cd /d "%~dp0.."
call venv\Scripts\activate.bat
echo === Pair this computer with the PS5 (one time) ===
echo PS5 IP: Settings ^> Network ^> Connection Status ^> View Connection Status
set /p PS5IP=PS5 IP address:
python -m pyremoteplay %PS5IP% --register
echo.
echo When it finished OK, put the IP and your PSN name in config.yaml (opening it now).
notepad config.yaml
pause
