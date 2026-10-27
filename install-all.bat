@echo off
REM OpenCluely - bootstrap installer for Windows
REM Double-click this file. It installs Node.js LTS, Python 3.12, Git (via winget),
REM then runs setup.bat (npm install + start).
REM Requires: Windows 10/11 with winget (preinstalled). Internet connection.

cd /d "%~dp0"
echo ========================================
echo  OpenCluely Bootstrap Installer
echo ========================================

where winget >nul 2>nul
if errorlevel 1 (
  echo [ERROR] winget not found. Update Windows 10/11 or install "App Installer" from Microsoft Store,
  echo then re-run this file.
  pause
  exit /b 1
)

echo [1/4] Installing Node.js LTS...
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
echo [2/4] Installing Python 3.12...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent
echo [3/4] Installing Git...
winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements --silent

echo [4/4] Refreshing PATH for this session...
set "PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;%ProgramFiles%\Git\bin;%ProgramFiles%\Python312;%ProgramFiles%\Python312\Scripts;%PATH%"

echo.
where node >nul 2>nul && (echo [OK] node: & call node -v) || echo [FAIL] Node not found - restart PC and re-run
where python >nul 2>nul && (echo [OK] python: & call python --version) || echo [FAIL] Python not found - restart PC and re-run
where git >nul 2>nul && (echo [OK] git: & call git --version) || echo [FAIL] Git not found - restart PC and re-run

echo.
echo Starting OpenCluely setup...
if exist setup.bat (
  call setup.bat
) else (
  echo [ERROR] setup.bat not found next to this file.
  pause
  exit /b 1
)
