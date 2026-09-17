@echo off
title SecNotes demo (ssh tunnel)

REM ASCII-ONLY launcher. Do NOT add non-ASCII text here:
REM cmd.exe reads .bat with the OEM codepage, and UTF-8 Chinese would
REM corrupt line parsing and make the window flash-and-close.

set "HERE=%~dp0"
set "PS1=%HERE%demo.ps1"

if not exist "%PS1%" (
    echo [ERROR] demo.ps1 is missing next to demo.bat
    echo         expected: %PS1%
    echo.
    pause
    exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] powershell.exe was not found in PATH.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [demo.bat] PowerShell exited with code %RC%.
    echo            Read the messages above for the cause.
    echo.
    pause
)

exit /b %RC%
