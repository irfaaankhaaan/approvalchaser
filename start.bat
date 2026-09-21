@echo off
setlocal

rem Always run from the folder this file is in, no matter where it was
rem double-clicked or launched from. This is what fixes "cd into the
rem right folder first" as a step anyone has to remember.
cd /d "%~dp0"

rem Runs through cmd.exe, not PowerShell, so PowerShell's script execution
rem policy never comes into it and npm never needs to be typed as npm.cmd.

echo ============================================
echo  Slack Approval Chaser
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found.
    echo Install it from https://nodejs.org ^(the LTS version^), then run this again.
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies - this takes a minute the first time...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Scroll up for the error.
        pause
        exit /b 1
    )
    echo.
)

if not exist .env.local (
    echo Setting up your local configuration...
    call npm run setup
    echo.
)

if not exist .pgdata (
    echo Loading three demo approvals so there is something to click on...
    call npm run db:seed
    echo.
)

echo ============================================
echo  Starting the app...
echo  Once you see "Ready", open:
echo    http://localhost:3000/dashboard   - create and manage approvals
echo  Or paste in one of the demo links printed above to see one already
echo  filled in. Press Ctrl+C in this window to stop the app.
echo ============================================
echo.
call npm run dev

echo.
echo The app has stopped.
pause
