@echo off
setlocal
title Veyon WebAPI diagnostic

set "OJ_SERVER=http://192.168.3.2:8080"

net session >nul 2>&1
if not "%errorlevel%"=="0" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "PS1=%TEMP%\diag.ps1"
if exist "%PS1%" del /f /q "%PS1%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%OJ_SERVER%/diag.ps1' -OutFile '%TEMP%\diag.ps1' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
    if exist "%~dp0diag.ps1" (
        set "PS1=%~dp0diag.ps1"
    ) else (
        echo [x] Cannot download diag.ps1 from %OJ_SERVER%
        pause
        exit /b 1
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" > "%TEMP%\veyon-diag.txt" 2>&1
type "%TEMP%\veyon-diag.txt"
echo.
echo Output saved to %TEMP%\veyon-diag.txt
echo.
pause
