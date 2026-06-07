@echo off
echo [1/3] Building backend...
call npm run build:backend
if errorlevel 1 (
    echo Backend build failed!
    pause
    exit /b 1
)

echo [2/3] Building webgui...
call npm run webgui:build
if errorlevel 1 (
    echo Webgui build failed!
    pause
    exit /b 1
)

echo [3/3] Restarting manager...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8790 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
start "" /b node dist/manager.js

echo Done! Manager restarted.
