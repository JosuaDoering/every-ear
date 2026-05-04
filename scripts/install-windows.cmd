@echo off
rem Cmd wrapper so users can run the install without changing PowerShell's
rem execution policy. Forwards any arguments to the .ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
exit /b %ERRORLEVEL%
