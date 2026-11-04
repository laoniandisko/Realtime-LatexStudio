@echo off
setlocal
pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo Cannot open the SideX LaTeX Studio directory.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LaTeXStudio.ps1" %*
set "studioExit=%errorlevel%"
popd
if not "%studioExit%"=="0" (
  echo.
  echo SideX LaTeX Studio could not start. See the message above.
  pause
)
exit /b %studioExit%
