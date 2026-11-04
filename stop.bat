@echo off
rem Double-click to stop Hermes Agency Hub. Your data is kept. See scripts\stop.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
set EXITCODE=%ERRORLEVEL%
pause
exit /b %EXITCODE%
