@echo off
cd /d "%~dp0"
:loop
node bridge.js >> bridge.log 2>> bridge.err.log
timeout /t 10 /nobreak >nul
goto loop
