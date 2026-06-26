<#
  dashboard.ps1 — start the Qwen↔vts web dashboard and open it in the browser.
  Double-click dashboard.cmd, or run:  .\dashboard.ps1 [-Port 7878] [-Project G:/path/to/repo]

  Foreground: server logs print here; close this window (or run stop-dashboard.ps1) to stop.
#>
param(
  [int]$Port = 7878,
  [string]$Project
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# node present?
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "node not found in PATH"; exit 1 }

# free the port if a previous instance is still listening
$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($old) {
  Write-Host "port $Port busy — stopping previous instance..."
  $old.OwningProcess | Select-Object -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force } catch {} }
  Start-Sleep -Milliseconds 500
}

$env:PORT = "$Port"
if ($Project) { $env:VTS_PROJECT = $Project }

# launch the server in THIS console (logs visible, Ctrl-C / window-close stops it)
Write-Host "starting dashboard on http://127.0.0.1:$Port ..."
$node = Start-Process node -ArgumentList "`"$here\dashboard.mjs`"" -PassThru -NoNewWindow

# wait for the port to accept, then open the browser
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $t = New-Object System.Net.Sockets.TcpClient
    $t.Connect("127.0.0.1", $Port); $t.Close(); $up = $true; break
  } catch { Start-Sleep -Milliseconds 400 }
}
if ($up) {
  Start-Process "http://127.0.0.1:$Port"
  Write-Host "opened browser. PID $($node.Id). Stop: close this window or run stop-dashboard.ps1 -Port $Port"
} else {
  Write-Warning "server did not come up on $Port; check output above."
}

# block on the server so this window owns its lifetime
Wait-Process -Id $node.Id
