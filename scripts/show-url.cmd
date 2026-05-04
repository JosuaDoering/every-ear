@echo off
rem Cmd wrapper for scripts\show-url.mjs.
node "%~dp0show-url.mjs" %*
exit /b %ERRORLEVEL%
