@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ============================================
echo   SecNotes Quick Start
echo   Build data\notes.js, then open the site.
echo  ============================================
echo.

rem --- locate Python 3 (py launcher first, then python) ---
set "PYCMD="
py -3 --version >nul 2>&1 && set "PYCMD=py -3"
if not defined PYCMD python --version >nul 2>&1 && set "PYCMD=python"

if not defined PYCMD (
    echo  [ERROR] Python 3 was not found.
    echo          Please install Python 3.8+ from https://www.python.org/downloads/
    echo          and check "Add python.exe to PATH", then run this script again.
    echo.
    pause
    exit /b 1
)

echo  [1/2] Building data\notes.js ...
%PYCMD% build.py
if errorlevel 1 (
    echo.
    echo  [ERROR] Build failed - see the messages above.
    echo.
    pause
    exit /b 1
)

echo  [2/2] Opening index.html ...
start "" "%~dp0index.html"
echo.
echo  Done.  Edit notes\*.md and run this script again to update the site.
pause