# Stops the local dev servers started by run-local.ps1 (website :3000, backend :4000, database :54329).
# Your data is kept in .local\pgdata. Run this, then run run-local.ps1 again.
foreach ($port in 3000, 4000, 54329) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep 2
foreach ($port in 3000, 4000, 54329) {
  $n = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
  Write-Host "port $port : $(if ($n -eq 0) { 'stopped' } else { 'STILL RUNNING - close its window manually' })"
}
Write-Host 'You can close the leftover PowerShell windows now.'
