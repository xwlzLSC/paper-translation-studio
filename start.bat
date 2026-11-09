@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
if not defined PDF2ZH_HOME set "PDF2ZH_HOME=%~dp0.."
set "PAPER_PYTHON=%PDF2ZH_HOME%\pdf2zh\build\runtime\python.exe"
if not exist "%PAPER_PYTHON%" set "PAPER_PYTHON=%PDF2ZH_HOME%\build\runtime\python.exe"
if not exist "%PAPER_PYTHON%" set "PAPER_PYTHON=%PDF2ZH_HOME%\runtime\python.exe"
if not exist "%PAPER_PYTHON%" (
  echo PDF2zh portable runtime not found. Set PDF2ZH_HOME to the extracted folder.
  pause
  exit /b 1
)
if "%~1"=="--install-offline" (
  "%PAPER_PYTHON%" -X utf8 -B "%~dp0offline_translation.py"
  if errorlevel 1 pause
  exit /b
)
"%PAPER_PYTHON%" -X utf8 -B "%~dp0server.py" --app %*
if errorlevel 1 pause
