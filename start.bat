@echo off
chcp 65001 >nul
title Мессенджер на Rust
cd /d "%~dp0"

set PORT=8080
if not "%~1"=="" set PORT=%~1

echo Запускаю сервер чата на порту %PORT% ...
start "" "http://127.0.0.1:%PORT%/"
"%~dp0target\release\rust-messenger.exe"

echo.
echo Сервер остановлен.
pause
