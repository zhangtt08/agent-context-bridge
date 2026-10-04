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
rem The API binds 127.0.0.1 only and rejects any Origin that is not its own loopback
rem host:port (see server/core/local-guard.ts). In dev the page lives on vite's :5173 and
rem calls /api through the proxy, so that origin has to be allowed explicitly. Loopback
rem origins only - a non-loopback value here makes the server refuse to start on purpose.
if "%ACB_ALLOWED_ORIGINS%"=="" set "ACB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173"
call npm run dev
exit /b %errorlevel%

:failed
echo [ERROR] npm install failed.
pause
exit /b 1
