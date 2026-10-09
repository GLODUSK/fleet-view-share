@echo off
rem Fleet View: live view of every Claude Code session and how close its work is to production.
rem Type "fleet-view" in any cmd window once this folder is on PATH.
rem
rem Default (web): serves the view on http://127.0.0.1:4777 and opens it in the app window (the blurred desktop window from desktop/ once installed, else Edge). The server
rem runs hidden (fleet-view.vbs), with no console window; the app stops it. "fleet-view --tui" runs the
rem terminal view instead: outside Windows Terminal it opens a tab with the blurred Fleet View profile,
rem inside it runs in place. "fleet-view --install-startup" / "--remove-startup" add or remove the
rem shortcut that starts Fleet View at sign-in, in this console. Before editing, read "resumed" below.
setlocal
echo. %* | findstr /i /c:"--install-startup" /c:"--remove-startup" >nul && goto cli
echo. %* | findstr /i /c:"--tui" /c:"--snapshot" /c:"--install-profile" /c:"--help" >nul && goto tui

rem ---------- web ----------
rem the console that typed "fleet-view" is handed back at once: the rest runs hidden (fleet-view.vbs)
if defined FLEET_VIEW_CHILD goto web
set FLEET_VIEW_CHILD=1
wscript //nologo "%~dp0fleet-view.vbs" %*
exit /b
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
rem ---------- resumed: a loop started by the previous fleet-view.cmd ----------
rem cmd.exe reads a batch file by byte offset while it runs it. When a pull rewrites this file, a restart
rem loop that the previous version started (the web loop, or --tui) reads its next line at the same offset
rem in the new file: right after its "node" line, bytes 1314 and 1950 of that version as checked out with
rem CRLF (1288 and 1905 with LF). Those offsets fall inside the colon lines above, which cmd skips as
rem labels, so the old loop comes here with node's exit code and carries on in this version's loop instead
rem of running half a line. Keep the lines above the colons as short as they are. When you change this
rem file next, the running loops of this version resume right after its two "node" lines: put a block of
rem colon lines (and a "goto resumed") over those offsets in the new version too.
:resumed
set FV_CODE=%errorlevel%
echo. %* | findstr /i /c:"--tui" /c:"--snapshot" /c:"--install-profile" /c:"--help" >nul && goto tuiexited
goto webexited

:web
title Fleet View
chcp 65001 >nul
rem fleet-view.js exits with 75 when its file changes; start it again in the same console. The app window
rem stays open and reconnects by itself, so a restart passes --no-open instead of opening a second window.
rem Any other non-zero exit is a crash (76 is an uncaught exception; %LOCALAPPDATA%\fleet-view\server.log
rem says what happened): it starts again after 3 s, also with --no-open, and gives up after 5 crashes within
rem 2 minutes. Exit 0 (Ctrl+C, the console closed, or another Fleet View already serving) ends the loop.
set FLEET_VIEW_LOOP=1
set FV_NO_OPEN=
set FV_RESTART_REASON=
set "FV_LOG=%LOCALAPPDATA%\fleet-view\server.log"
set FV_C1=
set FV_C2=
set FV_C3=
set FV_C4=
set FV_C5=
:againweb
node "%~dp0fleet-view.js" --web %FV_NO_OPEN% %*
set FV_CODE=%errorlevel%
:webexited
if "%FV_CODE%"=="0" exit /b 0
set FV_NO_OPEN=--no-open
if not "%FV_CODE%"=="75" goto crashed
set "FV_RESTART_REASON=an update (exit 75)"
goto againweb
:crashed
if not defined FV_LOG set "FV_LOG=%LOCALAPPDATA%\fleet-view\server.log"
call :now
rem the times of the last five crashes, oldest first
set FV_C1=%FV_C2%
set FV_C2=%FV_C3%
set FV_C3=%FV_C4%
set FV_C4=%FV_C5%
set FV_C5=%FV_NOW%
if not defined FV_C1 goto crashwait
set /a FV_SPAN=FV_NOW-FV_C1
if %FV_SPAN% GTR 120 goto crashwait
call :log "gave up: 5 crashes within 2 minutes, the last with exit code %FV_CODE%; run fleet-view again to start it"
echo Fleet View crashed 5 times within 2 minutes and was not started again. See %FV_LOG%
exit /b %FV_CODE%
:crashwait
set "FV_RESTART_REASON=a crash (exit %FV_CODE%)"
call :log "node exited with code %FV_CODE% (crash): starting it again in 3 s with --no-open"
echo Fleet View stopped with exit code %FV_CODE%; starting it again in 3 s. Log: %FV_LOG%
rem timeout refuses to run when its input is redirected; ping waits the same 3 s then
timeout /t 3 /nobreak >nul 2>nul || ping -n 4 127.0.0.1 >nul
goto againweb

rem ---------- autostart shortcut: runs here, then ends ----------
:cli
node "%~dp0fleet-view.js" %*
exit /b %errorlevel%

rem ---------- terminal view ----------
:tui
if defined WT_SESSION goto run
where wt >nul 2>nul || goto run
start "" wt -w fleet-view new-tab -p "Fleet View" --title "Fleet View" cmd /c "%~f0" %*
exit /b
:run
title Fleet View
chcp 65001 >nul
rem fleet-view.js exits with 75 when its file changes; start it again in the same window, so it never moves
rem (--no-open on restarts too, for a tab started before the app window existed, which now reloads into it)
set FLEET_VIEW_LOOP=1
set FV_NO_OPEN=
:again
node "%~dp0fleet-view.js" %FV_NO_OPEN% %*
set FV_CODE=%errorlevel%
:tuiexited
if not "%FV_CODE%"=="75" exit /b %FV_CODE%
set FV_NO_OPEN=--no-open
goto again

rem ---------- helpers for the web loop ----------
rem :now sets FV_NOW (seconds since 1970) and FV_AT (local time, the way server.log writes it)
:now
set FV_NOW=0
set FV_AT=
for /f "tokens=1,*" %%a in ('node -e "const d=new Date();console.log(Math.floor(d/1e3)+' '+new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,23).replace('T',' '))"') do (
  set "FV_NOW=%%a"
  set "FV_AT=%%b"
)
exit /b
rem :log "text" adds a line to server.log
:log
if not exist "%LOCALAPPDATA%\fleet-view" mkdir "%LOCALAPPDATA%\fleet-view" >nul 2>nul
>>"%FV_LOG%" echo %FV_AT% [fleet-view.cmd] %~1
exit /b
