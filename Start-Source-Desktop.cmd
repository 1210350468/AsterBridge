@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "BUN_EXE="
for /f "delims=" %%B in ('where bun 2^>nul') do if not defined BUN_EXE set "BUN_EXE=%%B"
if not defined BUN_EXE set "BUN_EXE=%USERPROFILE%\.codex-chatgpt-web\versions\3.0.0-win32-x64\runtime\bun.exe"

if not exist "%BUN_EXE%" (
  echo [AsterBridge] Bun was not found.
  echo Install Bun 1.4.0 or restore the packaged 3.0.0 runtime first.
  pause
  exit /b 1
)

set "SOURCE_PROXY="
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -Command "$p=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'; if($p.ProxyEnable -eq 1 -and $p.ProxyServer){$s=[string]$p.ProxyServer; if($s -match 'https=([^;]+)'){$v=$matches[1]} elseif($s -match 'http=([^;]+)'){$v=$matches[1]} else {$v=$s}; if($v -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://'){$v='http://'+$v}; Write-Output $v}"`) do set "SOURCE_PROXY=%%P"

if defined SOURCE_PROXY (
  set "ELECTRON_GET_USE_PROXY=true"
  set "HTTP_PROXY=%SOURCE_PROXY%"
  set "HTTPS_PROXY=%SOURCE_PROXY%"
  set "NO_PROXY=localhost,127.0.0.1,::1"
  echo [AsterBridge] Proxy: %SOURCE_PROXY%
)

echo [AsterBridge] Bun: %BUN_EXE%
echo [AsterBridge] Starting source desktop launcher...
"%BUN_EXE%" run app

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [AsterBridge] Launcher exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
