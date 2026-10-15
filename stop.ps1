$ErrorActionPreference = 'Stop'
$serverPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.js'))
$pathPattern = [regex]::Escape($serverPath).Replace('\\', '[/\\]')
$managerProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like '*bun*' -and $_.CommandLine -match $pathPattern
}
foreach ($managerProcess in $managerProcesses) {
    Stop-Process -Id $managerProcess.ProcessId -ErrorAction SilentlyContinue
    Write-Output "Stopped OMP model manager PID $($managerProcess.ProcessId)."
}
if (-not $managerProcesses) {
    Write-Output 'OMP model manager is not running from this directory.'
}
