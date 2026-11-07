@echo off
setlocal
title Veyon WebAPI one-click setup

rem ===== OJ server (change this single line if the server IP changes) =====
set "OJ_SERVER=http://192.168.3.2:8080"

rem ---------- elevation ----------
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo.
    echo Requesting administrator privileges...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ============================================================
echo  Veyon WebAPI setup
echo  OJ server: %OJ_SERVER%
echo ============================================================
echo.

rem ---------- always fetch the latest setup script ----------
set "PS1=%TEMP%\student-setup.ps1"
if exist "%PS1%" del /f /q "%PS1%" >nul 2>&1
echo Downloading latest setup script...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%OJ_SERVER%/student-setup.ps1' -OutFile '%TEMP%\student-setup.ps1' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
    if exist "%~dp0student-setup.ps1" (
        echo [!] Download failed, falling back to the local copy.
        set "PS1=%~dp0student-setup.ps1"
    ) else (
        echo.
        echo [x] Cannot download student-setup.ps1 from %OJ_SERVER%
        echo     Check the server address and that the deploy service is running.
        echo.
        pause
        exit /b 1
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Source "%OJ_SERVER%"
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" (
    echo [x] Setup failed. Read the messages above.
) else (
    echo [*] Finished. You can close this window.
)
echo.
pause
exit /b %RC%
