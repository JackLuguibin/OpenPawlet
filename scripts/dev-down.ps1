$ErrorActionPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$ports = @(3000, 3001, 8000, 8765)
$namePattern = "^(python|console|nanobot|node|esbuild)(\.exe)?$"

Write-Output "[dev-down] stopping OpenPawlet related processes..."

# 1) Kill processes launched from this repo.
$repoProcs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*$repoRoot*"
}
foreach ($proc in $repoProcs) {
    Stop-Process -Id $proc.ProcessId -Force
}

# 2) Kill any remaining listeners on known dev ports.
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port
    if ($conns) {
        $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pid in $pids) {
            Stop-Process -Id $pid -Force
        }
    }
}

# 3) Safety pass: process name + repo path filter.
$safety = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match $namePattern -and $_.CommandLine -like "*$repoRoot*"
}
foreach ($proc in $safety) {
    Stop-Process -Id $proc.ProcessId -Force
}

Start-Sleep -Milliseconds 500

Write-Output "[dev-down] port status:"
foreach ($port in $ports) {
    $conn = Get-NetTCPConnection -LocalPort $port
    if ($conn) {
        Write-Output ("PORT {0}: IN_USE" -f $port)
    } else {
        Write-Output ("PORT {0}: FREE" -f $port)
    }
}

Write-Output "[dev-down] done."
