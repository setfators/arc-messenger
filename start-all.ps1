# Запуск мессенджера и публичной ссылки одной командой.
# Сервер и туннель уже работают — повторно не поднимаются, печатается текущая ссылка.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = 8080
if ($args.Count -ge 1 -and $args[0]) { $port = [int]$args[0] }

$exe = Join-Path $root 'target\release\rust-messenger.exe'
$cf  = Join-Path $env:USERPROFILE '.local\bin\cloudflared.exe'
$cfLog = Join-Path $env:TEMP 'cf.log'
$linkFile = Join-Path $root 'ССЫЛКА_ДЛЯ_ДРУГА.txt'

function Test-Proc([string]$name) {
    [bool](Get-Process -Name $name -ErrorAction SilentlyContinue)
}

# 1. Сервер
if (-not (Test-Proc 'rust-messenger')) {
    if (-not (Test-Path $exe)) { Write-Host "Нет сборки: $exe — сначала cargo build --release"; exit 1 }
    Write-Host 'Запускаю сервер...'
    Start-Process -FilePath $exe -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    Write-Host 'Сервер уже запущен.'
}

# 2. Туннель
if (-not (Test-Proc 'cloudflared')) {
    if (-not (Test-Path $cf)) { Write-Host "Нет cloudflared: $cf"; exit 1 }
    Write-Host 'Поднимаю туннель...'
    if (Test-Path $cfLog) { Remove-Item $cfLog -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath $cf -ArgumentList 'tunnel','--url',"http://127.0.0.1:$port",'--no-autoupdate' -WindowStyle Hidden -RedirectStandardError $cfLog -RedirectStandardOutput (Join-Path $env:TEMP 'cf.out.log')
}

# 3. Ссылка
$link = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 750
    if (Test-Path $cfLog) {
        $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue |
             ForEach-Object { $_.Matches } | Select-Object -First 1
        if ($m) { $link = $m.Value; break }
    }
}

if (-not $link) {
    Write-Host 'Ссылку в логе туннеля не нашла. Смотри лог:' $cfLog
    exit 1
}

$text = @"
Мессенджер: $link
Локально:   http://127.0.0.1:$port

Отправь другу первую строку — он открывает её в браузере,
вводит любое имя и пишет в канал «obshiy» (или создаёт свой).
Ссылка живёт, пока открыт компьютер и работает туннель.
"@
$text | Out-File -FilePath $linkFile -Encoding utf8
Write-Host ''
Write-Host '========== ССЫЛКА ДЛЯ ДРУГА =========='
Write-Host $link
Write-Host '======================================'
Write-Host "Она же сохранена в: $linkFile"
Write-Host "Локально: http://127.0.0.1:$port"
Write-Host 'Открой ссылку у себя и перешли другу.'
