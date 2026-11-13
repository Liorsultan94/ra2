@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo === PS5 AI Remote: installation ===

where py >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Install Python 3.12 from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup. Then run this file again.
  pause
  exit /b 1
)

if not exist venv (
  py -3 -m venv venv || goto :fail
)
call venv\Scripts\activate.bat
python -m pip install --upgrade pip || goto :fail
pip install -r requirements.txt || goto :fail
pip install --no-deps pyremoteplay==0.7.6 || goto :fail

if not exist config.yaml copy config.example.yaml config.yaml >nul

echo.
echo Installed. Next: run windows\register.bat to pair with the PS5.
pause
exit /b 0

:fail
echo.
echo Installation failed. Copy the error above and send it.
pause
exit /b 1
