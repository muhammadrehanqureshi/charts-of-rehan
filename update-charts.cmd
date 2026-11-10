@echo off
rem Charts of Rehan: bring this checkout up to the latest master and rebuild
rem the web app the service serves.
rem
rem One pass, then it exits: no daemon, no watcher, no schedule, nothing left
rem running. The build is the only heavy step and it runs once.
rem
rem It refuses to run on a feature branch or a dirty tree, and it only ever
rem fast-forwards, so an update can never overwrite work in progress.
setlocal
cd /d "%~dp0"

set "FAILED="
echo == Update Charts of Rehan ==
echo.

rem --- guard: this must be the git checkout, on master -------------------------
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH (
  echo ABORT: this folder is not a git checkout; nothing was changed.
  set "FAILED=1"
  goto :report
)
if /i not "%BRANCH%"=="master" (
  echo ABORT: this checkout is on "%BRANCH%", not master.
  echo Land that branch through scripts\land.sh first, then update.
  set "FAILED=1"
  goto :report
)

rem --- guard: no local changes to hide ----------------------------------------
set "DIRTY="
for /f "delims=" %%c in ('git status --porcelain 2^>nul') do set "DIRTY=1"
if defined DIRTY (
  echo ABORT: local changes are present, so an update could hide them.
  echo Commit or stash them first; nothing was changed.
  set "FAILED=1"
  goto :report
)

rem --- fetch, then fast-forward only ------------------------------------------
echo Fetching origin/master ...
git fetch --quiet origin master
if errorlevel 1 (
  echo ABORT: origin could not be reached; the checkout is unchanged.
  set "FAILED=1"
  goto :report
)

for /f "delims=" %%h in ('git rev-parse --short HEAD') do set "BEFORE=%%h"
for /f "delims=" %%h in ('git rev-parse --short origin/master') do set "AFTER=%%h"

if "%BEFORE%"=="%AFTER%" (
  echo Already at master %BEFORE%: nothing new to pull.
) else (
  echo Fast-forwarding %BEFORE% to %AFTER% ...
  git merge --ff-only --quiet origin/master
  if errorlevel 1 (
    echo ABORT: master could not fast-forward; the checkout was not changed.
    set "FAILED=1"
    goto :report
  )
)

rem --- dependencies, only when the lockfile moved ------------------------------
set "INSTALL="
if not exist "web\node_modules\.package-lock.json" set "INSTALL=1"
if not defined INSTALL (
  for /f "delims=" %%i in ('powershell -NoProfile -Command "if ((Get-Item -LiteralPath 'web\package-lock.json').LastWriteTime -gt (Get-Item -LiteralPath 'web\node_modules\.package-lock.json').LastWriteTime) { '1' }"') do set "INSTALL=%%i"
)
if defined INSTALL (
  echo Installing web dependencies, because the lockfile moved ...
  call npm --prefix web ci
  if errorlevel 1 (
    echo ABORT: the dependency install failed; web\dist still holds the last good build.
    set "FAILED=1"
    goto :report
  )
)

rem --- rebuild what the service serves -----------------------------------------
echo Building the web app ...
call npm --prefix web run build
if errorlevel 1 (
  echo ABORT: the build failed; web\dist still holds the last good build.
  set "FAILED=1"
  goto :report
)

:report
echo.
if defined FAILED (
  echo Update did not complete. The message above says why; nothing was merged.
) else (
  for /f "delims=" %%h in ('git rev-parse --short HEAD') do echo Checkout now at %%h.
  echo web\dist was rebuilt. Reload the chart with Ctrl+F5 to pick it up.
)
echo.
pause
if defined FAILED exit /b 1
exit /b 0
