@echo off
chcp 65001 >nul
cd /d "%~dp0.."
call venv\Scripts\activate.bat
if not exist anthropic_key.txt (
  echo Missing anthropic_key.txt. Create it next to config.yaml with your Anthropic API key inside.
  pause
  exit /b 1
)
set /p ANTHROPIC_API_KEY=<anthropic_key.txt
:loop
python server.py %*
echo Server stopped. Restarting in 5 seconds... (close this window to stop)
timeout /t 5 >nul
goto loop
