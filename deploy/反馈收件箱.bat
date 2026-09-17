@echo off
chcp 65001 >nul
title SecNotes - Feedback Inbox
echo =============================================
echo   SecNotes : Feedback inbox (GitHub issues)
echo =============================================
echo.
python -u "%~dp0feedback-inbox.py" %*
echo.
echo ---------------------------------------------
echo   Done. If network is down, retry later.
echo ---------------------------------------------
pause