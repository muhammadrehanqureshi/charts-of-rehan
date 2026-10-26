@echo off
rem Charts of Rehan: start the charting service on loopback and open it.
rem Closing this window stops the service. Nothing is left running.
rem
rem A second click must not start a second copy: two servers on one port
rem would both poll the broker feed, and the page would be answered by
rem whichever process happened to win. If the service already answers,
rem this only opens a tab on it.
setlocal
cd /d "%~dp0"
set PORT=8788

rem --- order-flow recorder ---------------------------------------------------
rem The tape comes from the broker's feed, banked by a second process:
rem `python -m src.data.feed_capture` writes data/feed_capture+. When its
rem heartbeat (data/feed_capture/status.json) is older than two minutes the
rem recorder is dead - that is the stall this file used to leave behind, the
rem "where is the data" morning. Starting it again is safe: the recorder
rem refuses a second copy on the same capture itself, and this check runs
rem once per click, never as a poll loop.
powershell -NoProfile -Command "$f = 'data\feed_capture\status.json'; $fresh = $false; if (Test-Path $f) { try { $j = Get-Content $f -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop; if ($j.running) { $fresh = ((Get-Date) - (Get-Item $f).LastWriteTime).TotalSeconds -lt 120 } } catch {} }; if (-not $fresh) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo Order-flow recorder is not live; starting it ...
  start "Charts recorder" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%~dp0'; python -m src.data.feed_capture >> data\recorder.log 2>&1"
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/api/health'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo Charts of Rehan is already running at http://127.0.0.1:%PORT%/ .
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

echo Starting Charts of Rehan at http://127.0.0.1:%PORT%/ ...
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"
python -m charts --port %PORT%
echo.
echo The service has stopped. Press any key to close this window.
pause >nul
