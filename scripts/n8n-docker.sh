#!/usr/bin/env bash
# Runs the n8n CLI inside the official n8n image (pin the same version as live).
# The repo is mounted at /work; the harness passes paths relative to the repo root.
# --network none: the test n8n has NO internet or LAN access, so nothing real can ever be called.
export MSYS_NO_PATHCONV=1                      # stop Git Bash on Windows rewriting /work paths
REPO="$(pwd -W 2>/dev/null || pwd)"            # Windows-style path under Git Bash, normal path elsewhere
USER_FLAG=()
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) USER_FLAG=(--user "$(id -u):$(id -g)") ;; esac
exec docker run --rm --network none "${USER_FLAG[@]}" \
  -e N8N_USER_FOLDER -e N8N_DIAGNOSTICS_ENABLED -e N8N_RUNNERS_ENABLED \
  -v "$REPO":/work -w /work \
  --entrypoint n8n "n8nio/n8n:${N8N_VERSION:-2.43.4}" "$@"
