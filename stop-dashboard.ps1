<#
  stop-dashboard.ps1 — stop the dashboard server (frees the port). Nothing was ever transmitted.
  Run:  .\stop-dashboard.ps1 [-Port 7878]
#>
param([int]$Port = 7878)
$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($c) {
  $c.OwningProcess | Select-Object -Unique | ForEach-Object {
    try { Stop-Process -Id $_ -Force; Write-Host "stopped pid $_ (port $Port)" } catch {}
  }
} else {
  Write-Host "no dashboard listening on $Port"
}
