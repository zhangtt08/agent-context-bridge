@echo off
rem ---------------------------------------------------------------------------
rem ACB dev launcher - runs the backend (tsx watch-free) and the renderer (vite)
rem with hot reload, side by side in this window.
rem
rem This does NOT produce the desktop app. For the built program use:
rem     release\ACB-win64\ACB.exe
rem Requires Node.js >= 20.19 (recommended 22 LTS) on PATH.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js not found on PATH. Please install Node.js 22 LTS first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto failed
)

echo Starting ACB in dev mode. Press Ctrl+C to stop both processes.
echo.
call npm run dev
exit /b %errorlevel%

:failed
echo [ERROR] npm install failed.
pause
exit /b 1
