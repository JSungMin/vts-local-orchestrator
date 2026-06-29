#!/usr/bin/env bash
# qvts.sh — macOS/Linux sibling of qvts.ps1. A thin wrapper so the Claude orchestrator (or you) can
# delegate a code-locator task to the local Qwen agent in one line, from any directory.
#
#   Claude usage (Bash tool):  qvts --json "where is X declared?"
#   Human usage:               qvts "find all callers of MyFunction"
#   Other repo:                qvts -p /path/to/repo "main entry point?"
#
#   --json            emit {task, answer, trace} JSON on stdout (deterministic for Claude to parse)
#   -p, --project P   target repo (else ~/.vs-token-safer/config.json projectPath)
#   rest              the natural-language locate task
#
# stdout = answer (or JSON). The agent's tool-call log + model token stream go to stderr, so a --json
# capture stays clean.
set -euo pipefail

# Resolve this script's real directory even when invoked through a symlink (e.g. ~/.local/bin/qvts).
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
HERE="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
BRIDGE="$HERE/vts-bridge.mjs"

JSON=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --json)            JSON=1; shift ;;
    -p|--project)      export VTS_PROJECT="$2"; shift 2 ;;
    --project=*)       export VTS_PROJECT="${1#*=}"; shift ;;
    -h|--help)         sed -n '2,16p' "$SOURCE"; exit 0 ;;
    --)                shift; while [ $# -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    *)                 ARGS+=("$1"); shift ;;
  esac
done

if [ "${#ARGS[@]}" -eq 0 ]; then
  echo "qvts: no task given. Try: qvts \"where is X declared?\"" >&2
  exit 2
fi

[ "$JSON" -eq 1 ] && export QVTS_JSON=1
exec node "$BRIDGE" "${ARGS[@]}"
