@echo off
setlocal enableextensions

REM Wrapper para adicionar cookies automaticamente ao yt-dlp quando cookies.txt existir no projeto
set ROOT=%~dp0..\
if exist "%ROOT%cookies.txt" (
  yt-dlp.exe --cookies "%ROOT%cookies.txt" %*
) else (
  yt-dlp.exe %*
)

endlocal
