@echo off
REM OpenCluely Windows setup - double-click friendly
REM 1. Creates .env from env.example if missing
REM 2. Installs Node dependencies
REM 3. Starts app (Whisper venv + models auto-install on first launch via onboarding)

cd /d "%~dp0"

echo ========================================
echo  OpenCluely Setup (Windows)
echo ========================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18+ not found. Install from https://nodejs.org/ then re-run.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Reinstall Node.js with npm.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [WARN] Python 3.10+ not found. Whisper voice input will prompt to install it.
  echo Download from https://www.python.org/downloads/ ^(check "Add Python to PATH"^)
)

if not exist .env (
  if exist env.example (
    echo Creating .env from env.example...
    copy env.example .env >nul
  ) else (
    echo [ERROR] env.example missing
    pause
    exit /b 1
  )
) else (
  echo .env already exists, keeping it.
)

echo Installing Node dependencies (npm install)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed
  pause
  exit /b 1
)

echo.
echo Setup complete. Starting app...
echo (First launch: enter API keys in Settings if needed, Whisper installs automatically)
call npm start
pause
