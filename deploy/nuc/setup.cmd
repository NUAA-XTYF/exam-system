@echo off
setlocal
title Veyon WebAPI one-click setup

rem ===== OJ server (change this single line if the server IP changes) =====
set "OJ_SERVER=http://192.168.3.2:8080"

rem =====================================================================
rem  0. Veyon installed?  If not, guide the student to the official
rem     download page. This runs BEFORE elevation so the browser opens
rem     as the normal user and no UAC prompt is needed just to read it.
rem =====================================================================
set /a VEYON_TRIES=0
:check_veyon
set "VEYON_CLI="
if exist "%ProgramFiles%\Veyon\veyon-cli.exe" set "VEYON_CLI=%ProgramFiles%\Veyon\veyon-cli.exe"
if not defined VEYON_CLI if exist "%ProgramFiles(x86)%\Veyon\veyon-cli.exe" set "VEYON_CLI=%ProgramFiles(x86)%\Veyon\veyon-cli.exe"
if defined VEYON_CLI goto :veyon_ready

powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ''; Write-Host '============================================================' -ForegroundColor Red; Write-Host ' Veyon is NOT installed on this PC.' -ForegroundColor Red; Write-Host ' This machine must install Veyon 4.11.4 before the exam.' -ForegroundColor Red; Write-Host '============================================================' -ForegroundColor Red; Write-Host ''; Write-Host ' STEP 1  Connect this PC to the INTERNET' -ForegroundColor Yellow; Write-Host '         phone hotspot or another Wi-Fi that has internet.'; Write-Host '         Do NOT stay on the exam network - it has no internet.'; Write-Host ''; Write-Host ' STEP 2  Press any key here.' -ForegroundColor Yellow; Write-Host '         The official download page will open in your browser.'; Write-Host ''"
pause >nul

start "" "https://veyon.io/en/download/"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ''; Write-Host ' Download and install:  veyon-4.11.4-win64-setup.exe' -ForegroundColor Yellow; Write-Host ' (students only need the Veyon service; Veyon Master is optional)'; Write-Host ''; Write-Host ' If the browser did not open, go to:' -ForegroundColor Yellow; Write-Host '   https://veyon.io/en/download/'; Write-Host ''; Write-Host ' STEP 3  After installing, reconnect to the EXAM Wi-Fi' -ForegroundColor Yellow; Write-Host '         your IP must be 192.168.3.x'; Write-Host ''; Write-Host ' STEP 4  Press any key here to continue.' -ForegroundColor Yellow; Write-Host ''"
pause >nul

set /a VEYON_TRIES+=1
if %VEYON_TRIES% geq 5 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ''; Write-Host '[x] Veyon still not found after 5 tries. Ask your teacher for help.' -ForegroundColor Red"
    echo.
    pause
    exit /b 1
)
goto :check_veyon
:veyon_ready

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
