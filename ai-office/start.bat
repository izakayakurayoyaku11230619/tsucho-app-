@echo off
rem AI Office start: double-click this file. First run also sets up Python parts.
cd /d "%~dp0server"
set PY=python
where python >nul 2>nul || set PY=py -3
%PY% --version >nul 2>nul || (
  echo Python is not installed.
  echo Install it from https://www.python.org/downloads/  ^(check "Add python.exe to PATH"^), then double-click this file again.
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe %PY% -m venv .venv
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8000/"
echo Open http://localhost:8000/ in your browser. Close this window to stop.
python -m uvicorn main:app --port 8000
pause
