<#
  setup.ps1 — one-shot provisioning for the Qwen↔vts pipeline. Re-runnable. Zero manual config:
  detects the GPU, picks a model tier, installs Ollama + the model, auto-resolves vs-token-safer and
  clangd, and writes qvts.config.json so every entry point (bridge / dashboard / CLI) reads one file.

    powershell -ExecutionPolicy Bypass -File .\setup.ps1
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Project G:/path/to/repo   # pin target repo

  Steps: 1 Ollama  2 GPU tier  3 server env  4 restart  5 pull+build  6 resolve vts/clangd  7 config  8 verify
#>
param(
  [string]$Project,
  [int]$Port = 7878,
  [string]$Model = "gemma4"   # gemma4 (default, benchmarked best on 16GB) | qwen14b | qwen3
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($m){ Write-Host $m -ForegroundColor Cyan }

# ---- 1. Ollama ----
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" }
if (-not (Test-Path $ollama)) {
  Say "Ollama not found — installing via winget..."
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
  if (-not (Test-Path $ollama)) { throw "Ollama install failed. Install manually: https://ollama.com" }
}
Say "ollama: $ollama"

# ---- 2. GPU VRAM tier ----
$vram = 0
try { $vram = [int]((& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits) -split "`n")[0].Trim() } catch {}
if ($vram -le 0) { Write-Warning "no NVIDIA GPU detected — model will run on CPU (slow)."; $vram = 8000 }

# model registry — tuned Modelfiles ship in the repo. gemma4:e4b is the benchmarked optimum on 16 GB
# (fast + accurate locator); qwen variants are for heavier GPUs / benchmarking. Pick with -Model.
$models = @{
  gemma4  = @{ base="gemma4:e4b";                        tag="gemma4-vts";     file="Modelfile.gemma4" }
  qwen14b = @{ base="qwen2.5-coder:14b-instruct-q4_K_M"; tag="qwen-coder-vts"; file="Modelfile.qwen25-14b" }
  qwen3   = @{ base="qwen3:8b";                          tag="qwen3-vts";      file="Modelfile.qwen3" }
}
if (-not $models.ContainsKey($Model)) { throw "unknown -Model '$Model'. One of: $($models.Keys -join ', ')" }
$m = $models[$Model]
$mfPath = Join-Path $here $m.file
if (-not (Test-Path $mfPath)) { throw "Modelfile not found: $mfPath" }
# read num_ctx straight from the tuned Modelfile so config matches what's built
$ctx = 16384
$ctxLine = (Get-Content $mfPath | Select-String -Pattern 'num_ctx\s+(\d+)')
if ($ctxLine) { $ctx = [int]$ctxLine.Matches[0].Groups[1].Value }
Say "GPU VRAM: $vram MiB  ->  model: $Model  [$($m.base) -> $($m.tag), num_ctx $ctx]"

# ---- 3. server env (fit + reliability) ----
$envVars = @{
  OLLAMA_FLASH_ATTENTION   = "1"      # enables quantized KV cache
  OLLAMA_KV_CACHE_TYPE     = "q8_0"   # ~halves KV memory so the chosen ctx fits
  OLLAMA_KEEP_ALIVE        = "30m"    # keep resident between turns
  OLLAMA_MAX_LOADED_MODELS = "1"      # don't get evicted by another model
  OLLAMA_NUM_PARALLEL      = "1"      # single agent -> full ctx (else ctx is split across slots)
}
foreach ($k in $envVars.Keys) { [Environment]::SetEnvironmentVariable($k,$envVars[$k],"User"); Set-Item "Env:$k" $envVars[$k] }
Say "server env pinned (flash-attn, q8 KV, keep-alive, parallel=1, max-loaded=1)"

# ---- 4. restart server so env applies ----
Get-Process ollama,"ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
$log = Join-Path $here "ollama-serve.log"
Start-Process $ollama -ArgumentList "serve" -RedirectStandardError $log -RedirectStandardOutput "$log.out" -WindowStyle Hidden
$up=$false; for($i=0;$i -lt 20;$i++){ try{ Invoke-RestMethod "http://127.0.0.1:11434/api/version" -TimeoutSec 2|Out-Null;$up=$true;break }catch{ Start-Sleep 1 } }
if (-not $up) { throw "Ollama API not responding (see $log)" }
Say "Ollama API up."

# ---- 5. pull base + build the tuned variant ----
Say "pulling $($m.base) (first run downloads weights)..."
& $ollama pull $m.base
if ($LASTEXITCODE -ne 0) { throw "pull failed" }
& $ollama create $m.tag -f $mfPath
if ($LASTEXITCODE -ne 0) { throw "create failed" }
Say "built model: $($m.tag)"

# ---- 6. resolve vts server + clangd + target project ----
$vtsCandidates = @(
  $env:VTS_SERVER,
  "$env:USERPROFILE/.claude/plugins/vs-token-safer/server/index.js",
  (Join-Path (Split-Path $here -Parent) "vs-token-safer/server/index.js")
) | Where-Object { $_ }
$vtsServer = $vtsCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vtsServer) {
  $found = Get-ChildItem -Path "$env:USERPROFILE/.claude" -Recurse -Filter "index.js" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "vs-token-safer[\\/]server[\\/]index\.js$" } | Select-Object -First 1
  if ($found) { $vtsServer = $found.FullName }
}
if (-not $vtsServer) { Write-Warning "vs-token-safer server not auto-found — set vtsServer in qvts.config.json manually." }

$vtsCfgPath = "$env:USERPROFILE/.vs-token-safer/config.json"
$clangd = $null; $project = $Project
if (Test-Path $vtsCfgPath) {
  try { $vc = Get-Content $vtsCfgPath -Raw | ConvertFrom-Json; $clangd = $vc.clangdCmd; if (-not $project) { $project = $vc.projectPath } } catch {}
}
if (-not $clangd) { $clangd = (Get-Command clangd -ErrorAction SilentlyContinue).Source }
Say "vts server: $vtsServer"
Say "clangd:     $clangd"
Say "project:    $project"

# ---- 7. write qvts.config.json ----
$cfg = [ordered]@{
  model     = $m.tag
  numCtx    = $ctx
  maxSteps  = 25
  vtsServer = ($vtsServer -replace '\\','/')
  project   = ($project -replace '\\','/')
  clangd    = ($clangd -replace '\\','/')
  port      = $Port
  ollamaHost= "http://127.0.0.1:11434"
  vramMiB   = $vram
  tier      = "$Model ($($m.base))"
}
$cfg | ConvertTo-Json | Set-Content -Path (Join-Path $here "qvts.config.json") -Encoding utf8
Say "wrote qvts.config.json"

# ---- 8. verify ----
& $ollama run $m.tag "ok" | Out-Null
Say ""
Write-Host "DONE." -ForegroundColor Green
& $ollama ps
Write-Host ""
Write-Host "  Model:      $($m.tag)  (re-run with -Model qwen14b|qwen3 to switch)"
Write-Host "  Dashboard:  .\dashboard.cmd        (opens http://127.0.0.1:$Port)"
Write-Host "  CLI:        node vts-bridge.mjs `"where is X declared?`""
Write-Host "  Verify GPU: ollama ps  -> PROCESSOR must read 100% GPU"
