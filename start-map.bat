@echo off
REM ---------------------------------------------------------------------
REM Double-click this to use the map. It starts the local web server and
REM opens the page in your browser.
REM
REM The server has to keep running while you use the map, which is why
REM this window stays open. Closing it stops the server.
REM
REM This does NOT fetch Census data - that is a separate one-time step
REM (scripts\fetch-blockgroup-data.py). See README.md.
REM ---------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo   LA County Block Group Explorer
echo   ------------------------------
echo.
echo   Opening http://localhost:8000/blockgroups.html
echo.
echo   KEEP THIS WINDOW OPEN while you use the map.
echo   Press Ctrl+C or close this window when you are done.
echo.

REM Wait briefly so the server is listening before the browser asks for
REM the page, then open the default browser. Runs detached so it does not
REM hold up the server below.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8000/blockgroups.html'"

python -m http.server 8000

REM Reached only if the server exits - usually because port 8000 is
REM already taken by a server left running in another window.
echo.
echo   The server stopped. If that was immediate, port 8000 is probably
echo   already in use - close any other server window and try again.
echo.
pause
