@echo off
setlocal

REM ==============================
REM  ENTRA NA PASTA DO SCRIPT
REM ==============================
cd /d "%~dp0"

REM ==============================
REM  DETECTA LOCAL DO GIT
REM ==============================
for /f "delims=" %%G in ('where git 2^>nul') do (
    set "GIT_EXE=%%G"
    goto :foundgit
)

echo ❌ Git não encontrado no PATH.
echo Instale o Git for Windows para continuar.
pause
exit /b

:foundgit
echo ✔ Git encontrado em "%GIT_EXE%"
echo.

REM ==============================
REM  VERIFICA SE É UM REPO GIT
REM ==============================
if not exist ".git" (
    echo ❌ Esta pasta nao é um repositório Git.
    echo Coloque este BAT dentro de um repositório clonado.
    pause
    exit /b
)

REM ==============================
REM  MOSTRA REMOTO ATUAL
REM ==============================
echo 🔗 Repositório remoto:
"%GIT_EXE%" remote -v
echo.

REM ==============================
REM  PUXA ALTERAÇÕES
REM ==============================
echo 🔄 Atualizando repositório com git pull...
"%GIT_EXE%" pull

echo.
echo ✔ Repositório atualizado com sucesso!
pause