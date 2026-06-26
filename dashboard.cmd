@echo off
REM Double-click to launch the Qwen<->vts web dashboard and open it in your browser.
REM Pass-through args, e.g.:  dashboard.cmd -Port 8080 -Project C:/path/to/your-project
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0dashboard.ps1" %*
