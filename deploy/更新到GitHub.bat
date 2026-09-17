@echo off
chcp 65001 >nul
title SecNotes deploy to GitHub Pages
echo =============================================
echo   SecNotes : build + jsDelivr + push GitHub
echo =============================================
echo.
python "%~dp0deploy.py" --push
echo.
if errorlevel 1 (
    echo ##########################################
    echo #   FAILED - look at the messages above  #
    echo ##########################################
) else (
    echo ##########################################
    echo #   DONE - page live in 1-2 min         #
    echo #   https://USERNAME.github.io/REPO/     #
    echo ##########################################
)
echo.
pause