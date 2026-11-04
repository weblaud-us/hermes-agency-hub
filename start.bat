@echo off
rem Double-click to start Hermes Agency Hub. See scripts\start.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
set EXITCODE=%ERRORLEVEL%
pause
exit /b %EXITCODE%
