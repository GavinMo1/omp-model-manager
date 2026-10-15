$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$url = 'http://127.0.0.1:18764/'
$existing = Get-NetTCPConnection -LocalPort 18764 -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
    $bun = (Get-Command bun.exe -ErrorAction Stop).Source
    Start-Process -FilePath $bun -ArgumentList @('run', ('"' + (Join-Path $appDir 'server.js') + '"')) -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appDir 'server.log') -RedirectStandardError (Join-Path $appDir 'server-error.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        if (Get-NetTCPConnection -LocalPort 18764 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
    }
    if (-not $ready) { throw 'OMP model manager could not start. See server-error.log.' }
}
Start-Process $url
