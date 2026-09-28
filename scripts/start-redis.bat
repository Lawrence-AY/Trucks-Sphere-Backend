@echo off
REM ============================================
REM  TruckSphere — Start Redis on Windows
REM ============================================
REM  Downloads & runs Redis for Windows natively
REM  (no WSL, no Docker required)
REM
REM  Redis will run on port 6379 by default.
REM  The backend connects automatically via REDIS_URL.
REM ============================================

set REDIS_VERSION=3.0.504
set REDIS_URL=https://github.com/microsoftarchive/redis/releases/download/win-%REDIS_VERSION%/Redis-x64-%REDIS_VERSION%.msi
set REDIS_INSTALLER=Redis-x64-%REDIS_VERSION%.msi
set REDIS_DIR=%ProgramFiles%\Redis
set REDIS_CLI=%REDIS_DIR%\redis-cli.exe
set REDIS_SERVER=%REDIS_DIR%\redis-server.exe

echo ============================================
echo  TruckSphere — Redis for Windows Setup
echo ============================================
echo.

REM Check if Redis is already installed
if exist "%REDIS_SERVER%" (
    echo  Redis found at: %REDIS_DIR%
    goto :start
)

echo  Redis not found. Downloading Redis %REDIS_VERSION% for Windows...
echo  URL: %REDIS_URL%
echo.

REM Download the MSI installer
powershell -Command "Invoke-WebRequest -Uri '%REDIS_URL%' -OutFile '%TEMP%\%REDIS_INSTALLER%'"
if %ERRORLEVEL% NEQ 0 (
    echo  ERROR: Failed to download Redis.
    echo.
    echo  Manual install options:
    echo    1. Download from: https://github.com/microsoftarchive/redis/releases
    echo    2. OR install Memurai Dev: https://www.memurai.com/get-memurai
    echo.
    pause
    exit /b 1
)

echo  Installing Redis (requires administrator privileges)...
msiexec /i "%TEMP%\%REDIS_INSTALLER%" /quiet /norestart
if %ERRORLEVEL% NEQ 0 (
    echo  WARNING: MSI install returned code %ERRORLEVEL%.
    echo  Redis may already be installed. Trying to start anyway...
)

REM Clean up installer
del "%TEMP%\%REDIS_INSTALLER%" 2>nul

:start
echo  Starting Redis server on port 6379...
echo.

REM Check if Redis is already running
%REDIS_CLI% ping >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  Redis is already running.
    %REDIS_CLI% info server | findstr redis_version
    %REDIS_CLI% info server | findstr process_id
    goto :done
)

REM Start Redis as a background process
start "TruckSphere-Redis" /MIN "%REDIS_SERVER%" --port 6379 --maxmemory 256mb

REM Wait for Redis to be ready
echo  Waiting for Redis to accept connections...
set RETRIES=0
:wait
timeout /t 1 /nobreak >nul
%REDIS_CLI% ping >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :ready
set /a RETRIES+=1
if %RETRIES% LSS 10 goto :wait

echo  WARNING: Redis did not start within 10 seconds.
echo  Check if port 6379 is already in use or if installation failed.
pause
exit /b 1

:ready
echo.
echo  Redis is running!
%REDIS_CLI% info server | findstr redis_version
echo.
echo  Backend will auto-connect via REDIS_URL=redis://127.0.0.1:6379
echo.

:done
echo  ============================================
echo  You can now start the backend: npm run dev
echo  ============================================
echo.
pause