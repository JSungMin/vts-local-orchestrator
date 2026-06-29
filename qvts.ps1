<#
  qvts.ps1 — thin wrapper so the Claude orchestrator (or you) can delegate a code-locator task to the
  local Qwen agent in one line, without remembering node paths or env.

  Claude usage (Bash tool):  pwsh -File /path/to/qvts.ps1 -Json "where is X declared?"
  Human usage:               .\qvts.ps1 "find all callers of MyFunction"

  -Json     emit {task, answer, trace} JSON (deterministic for Claude to parse)
  -Project  override target repo (else ~/.vs-token-safer/config.json projectPath)
  rest      the natural-language task
#>
param(
  [switch]$Json,
  [string]$Project,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Task
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridge = Join-Path $here "vts-bridge.mjs"

if (-not $Task -or $Task.Count -eq 0) { Write-Error "no task given"; exit 2 }
if ($Project) { $env:VTS_PROJECT = $Project }
if ($Json)    { $env:QVTS_JSON = "1" }

# stdout = answer (or JSON); the agent's tool-call log goes to stderr so a -Json capture stays clean.
& node $bridge ($Task -join " ")
exit $LASTEXITCODE
