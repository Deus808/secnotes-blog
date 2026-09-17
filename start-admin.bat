@echo off
title SecNotes launcher

REM ============================================================
REM  SecNotes sync service launcher
REM ------------------------------------------------------------
REM  ASCII-ONLY FILE, CRLF line endings. Do NOT add non-ASCII text:
REM  cmd.exe reads .bat with the OEM codepage (GBK on zh-CN), and
REM  UTF-8 Chinese corrupts line parsing -> the window flashes and
REM  closes with no message. Same rule as bin\demo.bat.
REM
REM  Order matters: the service is started FIRST and we wait until
REM  it actually listens on 8080, because manage.html probes for the
REM  service only once at boot. Opening the page too early means the
REM  "sync to site" button never appears until a manual refresh.
REM ============================================================

cd /d "%~dp0"

if not exist "admin.py" (
    echo [ERROR] admin.py not found next to this script.
    pause
    exit /b 1
)

REM ---- force UTF-8 for every Python child process ----
REM Chinese Windows defaults to GBK (cp936) for console and pipes, and GBK cannot
REM encode emoji. Our Python tools print emoji in their summaries, so without this
REM they die with UnicodeEncodeError and the whole build fails. Set here (rather
REM than only inside each script) so every child process inherits it; the
REM in-script reconfigure() calls remain as a second line of defence.
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

REM ---- pick a Python interpreter ----
set "PYEXE="
where py >nul 2>nul
if not errorlevel 1 set "PYEXE=py -3"

if not defined PYEXE (
    where python >nul 2>nul
    if not errorlevel 1 set "PYEXE=python"
)

if not defined PYEXE (
    echo [ERROR] No Python interpreter found.
    echo         Tried: py -3  ^|  python
    echo         Install Python or add it to PATH, then run this again.
    pause
    exit /b 1
)

echo SecNotes sync service
echo   interpreter : %PYEXE%
echo   port        : 8080
echo.
echo The service runs in a separate window titled "SecNotes sync service".
echo Keep that window open - closing it stops the service.
echo.

start "SecNotes sync service" cmd /k "%PYEXE% admin.py"

echo Waiting for the service to listen on 8080 ...
set /a tries=0

:waitport
netstat -ano | findstr ":8080" | findstr /I "LISTENING" >nul
if not errorlevel 1 goto svcready
set /a tries+=1
if %tries% GEQ 20 goto svcready
ping -n 2 127.0.0.1 >nul
goto waitport

:svcready
echo   ... ready after %tries% checks.
echo.

REM Editor MUST be opened over http://, never as file://.
REM A file:// page cannot load scripts from http://127.0.0.1:8080 (Chrome blocks
REM cross-scheme script loads per Private Network Access rules), so the JSONP
REM token handshake fails and sync silently never runs. Opening it as http://
REM keeps manage.html and index.html on the same origin, which also makes the
REM reload signal work both ways.

if exist "manage.html" start "" "http://127.0.0.1:8080/manage.html"

echo Editor opened. If the "sync to site" button is missing, press F5 once.
echo This launcher window can be closed safely - the service window stays.
timeout /t 8
exit /b 0
