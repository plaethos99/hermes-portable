@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"
set "RUNTIME=%ROOT%runtime"
set "TEMP=%RUNTIME%\scratch"
set "TMP=%RUNTIME%\scratch"
set "TMPDIR=%RUNTIME%\scratch"
set "HERMES_PORTABLE=1"
set "HERMES_PORTABLE_ROOT=%ROOT%"
set "HERMES_HOME=%RUNTIME%\hermes"
set "HERMES_DESKTOP_USER_DATA_DIR=%RUNTIME%\electron"
set "PYTHONNOUSERSITE=1"
set "PYTHONPYCACHEPREFIX=%RUNTIME%\cache\pyc"
set "PIP_CACHE_DIR=%RUNTIME%\cache\pip"
set "UV_CACHE_DIR=%RUNTIME%\cache\uv"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%HERMES_HOME%" mkdir "%HERMES_HOME%"
if not exist "%HERMES_DESKTOP_USER_DATA_DIR%" mkdir "%HERMES_DESKTOP_USER_DATA_DIR%"
set "PYHOME=%RUNTIME%\python"
set "CFG=%HERMES_HOME%\hermes-agent\venv\pyvenv.cfg"
if exist "%PYHOME%\python.exe" (
  >"%CFG%" echo home = %PYHOME%
  >>"%CFG%" echo include-system-site-packages = false
  >>"%CFG%" echo executable = %PYHOME%\python.exe
)
if not exist "%ROOT%out\main\index.js" (
  echo Building the desktop UI into this folder...
  node "%ROOT%scripts\run-portable.mjs" electron-vite build
  if errorlevel 1 exit /b 1
)
"%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%"
