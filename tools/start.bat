@echo off
setlocal
title Puffco BLE Controller
set "ROOT=%~dp0"
set "APP_URL=http://127.0.0.1:8420"
set "EMBED_PY=%ROOT%.python311\python.exe"
set "LOCAL_PY=%ROOT%.venv-puffco\Scripts\python.exe"
set "CHECK_ONLY=0"

if /i "%~1"=="--check" set "CHECK_ONLY=1"

echo.
echo  ======================================
echo   Puffco BLE Web Controller
echo  ======================================
echo.
echo  Windows local runtime
echo.

if exist "%EMBED_PY%" (
  "%EMBED_PY%" -c "import sys; import bleak, bleak_winrt, puffcoble, websockets" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=%EMBED_PY%"
)

if not defined PYTHON_EXE if exist "%LOCAL_PY%" (
  "%LOCAL_PY%" -c "import sys; import bleak, bleak_winrt, puffcoble, websockets" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=%LOCAL_PY%"
)

if not defined PYTHON_EXE if exist "C:\Python314\python.exe" (
  "C:\Python314\python.exe" -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=C:\Python314\python.exe"
)

if not defined PYTHON_EXE (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=py -3"
)

if not defined PYTHON_EXE (
  py -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=py"
)

if "%PYTHON_EXE%"=="" (
  set "PYTHON_EXE=%LOCAL_PY%"
)

if not defined PYTHON_EXE (
  echo  Python was not found.
  echo  Install Python 3.11+ for Windows, or restore .venv-puffco beside this file.
  echo.
  pause
  exit /b 1
)

if not exist "%ROOT%web\index.html" (
  echo  Missing web files under "%ROOT%web".
  echo  Run this file from the PuffcoBLE folder.
  echo.
  pause
  exit /b 1
)

if /i "%PYTHON_EXE%"=="py" (
  py -c "import sys; sys.path.insert(0, r'%ROOT%.venv-puffco\Lib\site-packages'); import bleak, bleak_winrt, puffcoble, websockets" >nul 2>nul
) else if /i "%PYTHON_EXE%"=="py -3" (
  py -3 -c "import sys; sys.path.insert(0, r'%ROOT%.venv-puffco\Lib\site-packages'); import bleak, bleak_winrt, puffcoble, websockets" >nul 2>nul
) else (
  "%PYTHON_EXE%" -c "import sys; sys.path.insert(0, r'%ROOT%.venv-puffco\Lib\site-packages'); import bleak, bleak_winrt, puffcoble, websockets" >nul 2>nul
)

if errorlevel 1 (
  echo  Missing runtime packages.
  echo  Expected PuffcoBLE, Bleak/WinRT, and websockets under:
  echo    %ROOT%.venv-puffco\Lib\site-packages
  echo.
  echo  Restore the .venv-puffco package folder or rebuild with requirements-web.txt.
  echo.
  pause
  exit /b 1
)

if "%CHECK_ONLY%"=="1" (
  echo  Runtime check passed.
  echo  Python: %PYTHON_EXE%
  exit /b 0
)

echo.
echo  Python: %PYTHON_EXE%
echo  Starting server on %APP_URL%
echo  Press Ctrl+C to stop.
echo.

:: Open browser after a short delay
start "" /B cmd /c "timeout /t 2 /nobreak >nul && start %APP_URL%"

:: Start the server
if /i "%PYTHON_EXE%"=="py" (
  py -X utf8 "%ROOT%server.py"
) else if /i "%PYTHON_EXE%"=="py -3" (
  py -3 -X utf8 "%ROOT%server.py"
) else (
  "%PYTHON_EXE%" -X utf8 "%ROOT%server.py"
)

echo.
echo  Server stopped.
