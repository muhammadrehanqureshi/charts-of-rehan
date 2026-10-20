@echo off
rem Charts of Rehan: start the charting service on loopback and open it.
rem Closing this window stops the service. Nothing is left running.
setlocal
cd /d "%~dp0"
set PORT=8788
echo Starting Charts of Rehan at http://127.0.0.1:%PORT%/ ...
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"
python -m charts --port %PORT%
echo.
echo The service has stopped. Press any key to close this window.
pause >nul
