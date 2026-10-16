#!/usr/bin/env bash
# n8n chamber: a sealed local n8n editor for playing with FAKED workflows.
#   ./scripts/n8n-chamber.sh proof   start the chamber, run the safety checks, tear it down
#   ./scripts/n8n-chamber.sh up [dir]   start the chamber and leave it running (dir = faked workflows to load)
#   ./scripts/n8n-chamber.sh run <dir> [export-dir]  load the faked workflows, start, wait; on Ctrl+C save any edits to export-dir, then remove everything
#   ./scripts/n8n-chamber.sh down       remove it (containers, network and its data), then report status
#   ./scripts/n8n-chamber.sh status     report whether anything is left: prints CLEAN (exit 0) or LEFTOVERS (exit 1)
#
# One window in, no door out:
#   IN   your browser reaches the editor at 127.0.0.1 only, through a tiny forwarder container.
#   OUT  n8n runs on an INTERNAL Docker network: no route to the internet or your LAN, for any node.
#   DISK your repo is NOT mounted. n8n only sees its own throwaway volume.
# Everything is deleted on `down`, so nothing typed into the editor survives.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1   # run from the repo root so relative paths mean the same everywhere
export MSYS_NO_PATHCONV=1                      # stop Git Bash on Windows rewriting /paths
IMAGE="n8nio/n8n:${N8N_VERSION:-2.43.4}"
PORT="${N8N_PORT:-5678}"
NET=n8n-chamber-net; APP=n8n-chamber-app; FWD=n8n-chamber-fwd; VOL=n8n-chamber-data; IMP=n8n-chamber-import; EXP=n8n-chamber-export
# Nodes that can run commands or touch files. One list, used by the editor and by the proof, so they cannot drift apart.
EXCLUDE='["n8n-nodes-base.executeCommand","n8n-nodes-base.readWriteFile","n8n-nodes-base.localFileTrigger"]'

down() {
  docker rm -f "$FWD" "$APP" "$IMP" "$EXP" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  return 0
}

# Reports whether anything from the chamber is still around. Exit 0 = clean, 1 = leftovers, 2 = cannot tell.
status() {
  docker info >/dev/null 2>&1 || { echo "UNKNOWN: Docker is not running, so leftovers cannot be checked."; return 2; }
  local left
  left=$({
    docker ps -a --filter "name=n8n-chamber" --format 'container {{.Names}} ({{.Status}})'
    docker network ls --filter "name=$NET" --format 'network {{.Name}}'
    docker volume ls --filter "name=$VOL" --format 'volume {{.Name}}'
  } 2>&1)
  if [ -z "$left" ]; then echo "CLEAN: no chamber containers, network or volume remain."; return 0; fi
  echo "LEFTOVERS:"; echo "$left"; echo "Remove them with: ./scripts/n8n-chamber.sh down"
  return 1
}

cleanup() { down; status; }

# Saves the workflows as they are NOW, including edits made in the editor, to a folder on this machine. The editor
# is stopped first so its database is flushed, then a short-lived container with NO network does the export and
# the files are copied out. This is the only thing that ever leaves the chamber, and only when asked.
export_edits() {
  local dest="$1" out rc
  mkdir -p "$dest" || return 1
  docker stop -t 20 "$APP" >/dev/null 2>&1
  docker create --name "$EXP" --network none --cap-drop ALL --security-opt no-new-privileges \
    -v "$VOL":/home/node/.n8n -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_RUNNERS_ENABLED=true \
    --entrypoint sh "$IMAGE" -c 'mkdir -p /tmp/export && n8n export:workflow --all --separate --output=/tmp/export' >/dev/null || return 1
  out=$(docker start -a "$EXP" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then docker cp "$EXP":/tmp/export/. "$dest" >/dev/null 2>&1; rc=$?; fi
  docker rm -f "$EXP" >/dev/null 2>&1
  if [ "$rc" -ne 0 ]; then echo "Could not export the edited workflows:"; echo "$out" | tail -5; return 1; fi
  return 0
}

# Used when `run` ends (Ctrl+C): save the edited copies if asked, then always remove everything.
finish() {
  if [ -n "${EXPORT_TO:-}" ] && docker inspect "$APP" >/dev/null 2>&1; then
    if export_edits "$EXPORT_TO"; then echo "Saved the workflows, with any edits you made and saved, to $EXPORT_TO"
    else echo "Your edits could not be saved; removing the chamber anyway."; fi
  fi
  cleanup
}

up() {
  down
  docker network create --internal "$NET" >/dev/null || return 1
  docker volume create "$VOL" >/dev/null || return 1
  # Optional: load faked workflows. A short-lived container with NO network imports them into the volume
  # before the editor starts; the files are copied in, so the repo is never mounted.
  if [ -n "${1:-}" ]; then
    docker create --name "$IMP" --network none --cap-drop ALL --security-opt no-new-privileges \
      -v "$VOL":/home/node/.n8n -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_RUNNERS_ENABLED=true \
      --entrypoint n8n "$IMAGE" import:workflow --separate --input=/tmp/variants >/dev/null || return 1
    docker cp "$1/." "$IMP":/tmp/variants || { docker rm -f "$IMP" >/dev/null 2>&1; return 1; }
    local out rc
    out=$(docker start -a "$IMP" 2>&1); rc=$?
    docker rm -f "$IMP" >/dev/null 2>&1
    if [ "$rc" -ne 0 ]; then echo "Importing the faked workflows failed:"; echo "$out" | tail -5; return 1; fi
  fi
  # The editor: internal network only, no published port, no repo mount, no extra privileges.
  docker run -d --init --name "$APP" --network "$NET" \
    --cap-drop ALL --security-opt no-new-privileges --memory 1g \
    -v "$VOL":/home/node/.n8n \
    -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    -e N8N_TEMPLATES_ENABLED=false -e N8N_PERSONALIZATION_ENABLED=false \
    -e N8N_RUNNERS_ENABLED=true -e N8N_SECURE_COOKIE=false \
    -e N8N_RESTRICT_FILE_ACCESS_TO=/home/node/.n8n-files \
    -e NODES_EXCLUDE="$EXCLUDE" \
    --entrypoint n8n "$IMAGE" start >/dev/null || return 1
  # The window: the only container with a published port, bound to loopback. It forwards inbound
  # connections to the editor and nothing else (same image, so there is nothing extra to download).
  docker run -d --init --name "$FWD" --cap-drop ALL --security-opt no-new-privileges --memory 128m \
    -p "127.0.0.1:${PORT}:5678" --entrypoint node "$IMAGE" -e \
    'const n=require("net");n.createServer(c=>{const s=n.connect(5678,"n8n-chamber-app");c.pipe(s);s.pipe(c);const k=()=>{c.destroy();s.destroy()};c.on("error",k);s.on("error",k);c.on("close",k);s.on("close",k)}).listen(5678,"0.0.0.0")' >/dev/null || return 1
  docker network connect "$NET" "$FWD" || return 1
}

# /healthz answers before n8n's REST API is ready, so also wait for /rest/settings.
wait_ready() {
  for _ in $(seq 1 90); do
    if curl -fs "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 \
       && curl -fs "http://127.0.0.1:${PORT}/rest/settings" 2>/dev/null | grep -q '"data"'; then return 0; fi
    sleep 1
  done
  return 1
}

# Creates the throwaway owner account, retrying while n8n finishes starting. Sets OWNER_REPLY on failure.
create_owner() {
  local reply
  for _ in $(seq 1 20); do
    reply=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' \
      -d '{"email":"chamber@example.com","firstName":"Chamber","lastName":"User","password":"Chamber1234"}' \
      -w ' [HTTP %{http_code}]' "http://127.0.0.1:${PORT}/rest/owner/setup" 2>&1)
    case "$reply" in *"[HTTP 200]"*|*"[HTTP 201]"*) return 0 ;; esac
    sleep 1
  done
  OWNER_REPLY="$reply"
  return 1
}

# Exit code 0 = the address was reached, 1 = it was not (blocked, no DNS, or timed out).
PROBE='fetch(process.argv[1],{signal:AbortSignal.timeout(6000)}).then(()=>process.exit(0),()=>process.exit(1))'

proof() {
  local pass=0 fail=0 inconclusive=0
  ok()  { echo "PASS: $1"; pass=$((pass + 1)); }
  bad() { echo "FAIL: $1"; fail=$((fail + 1)); }
  # A tiny known workflow to load, so the export round trip can be checked at the end.
  local fx=".n8n-dev/proof-fixture" ex=".n8n-dev/proof-export"
  trap "rm -rf '$fx' '$ex'; cleanup" EXIT          # expanded now: $fx and $ex are gone by the time the trap runs
  rm -rf "$fx" "$ex"; mkdir -p "$fx"
  cat > "$fx/proofroundtrip01.json" <<'JSON'
{"id":"proofroundtrip01","name":"proof round trip","active":false,"nodes":[{"id":"n1","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"position":[0,0],"parameters":{}}],"connections":{}}
JSON
  echo "Starting the chamber (image $IMAGE)..."
  up "$fx" || { echo "Could not start the chamber. Is Docker Desktop running and the image pulled?"; exit 1; }

  if wait_ready; then ok "editor answers at http://127.0.0.1:$PORT through the forwarder"
  else bad "editor did not answer within 90 seconds"; fi

  # Control: the same probe from a normal container must succeed, or "blocked" results prove nothing.
  if docker run --rm --entrypoint node "$IMAGE" -e "$PROBE" https://example.com >/dev/null 2>&1; then
    ok "control: a normal container can reach the internet, so the probe works"
  else
    echo "INCONCLUSIVE: the control probe could not reach the internet (offline?); results below prove nothing"
    inconclusive=1
  fi

  for url in https://example.com http://1.1.1.1; do
    if docker exec "$APP" node -e "$PROBE" "$url" >/dev/null 2>&1; then bad "the editor container REACHED $url"
    else ok "the editor container cannot reach $url"; fi
  done

  # The dangerous nodes must not load. The editor's own node list needs a login, so a short-lived sealed
  # container with the SAME exclusion setting lists the nodes n8n actually loads. The httpRequest line is the
  # control: if the list could not be produced, "not found" would mean nothing, so that case fails.
  local listed
  listed=$(docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
    -e NODES_EXCLUDE="$EXCLUDE" -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_RUNNERS_ENABLED=true \
    --entrypoint sh "$IMAGE" -c '
      n8n export:nodes --output=/tmp/nodes.json >/dev/null 2>&1
      grep -q "n8n-nodes-base.httpRequest" /tmp/nodes.json 2>/dev/null || { echo NOLIST; exit 0; }
      for t in executeCommand readWriteFile localFileTrigger; do
        grep -q "n8n-nodes-base.$t" /tmp/nodes.json && echo "$t"
      done' 2>/dev/null)
  if [ "$listed" = "NOLIST" ]; then bad "could not list the nodes n8n loads, so the node exclusions are unproven"
  elif [ -z "$listed" ]; then ok "execute-command and file read/write nodes do not load (the HTTP Request node does, as the control)"
  else bad "these nodes still load despite the exclusion: $(echo $listed)"; fi

  local mounts
  mounts=$(docker inspect "$APP" --format '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}')
  if [ "$mounts" = "volume:$VOL:/home/node/.n8n " ]; then ok "the only thing mounted in the editor is its own throwaway volume (your repo is not visible)"
  else bad "unexpected mounts in the editor container: $mounts"; fi

  if [ -z "$(docker port "$APP")" ]; then ok "the editor container publishes no ports"
  else bad "the editor container publishes a port: $(docker port "$APP")"; fi

  local ports
  ports=$(docker port "$FWD")
  if echo "$ports" | grep -q '127.0.0.1' && ! echo "$ports" | grep -q '0.0.0.0'; then ok "the forwarder is published on 127.0.0.1 only"
  else bad "the forwarder is published beyond loopback: $ports"; fi

  # Last on purpose: exporting stops the editor. The workflow loaded at the start must come back out of the
  # chamber intact, or edits made in it could never be pulled back.
  if export_edits "$ex" && grep -q '"name": *"proof round trip"' "$ex/proofroundtrip01.json" 2>/dev/null; then
    ok "a workflow loaded into the chamber can be exported back out"
  else bad "the workflow loaded into the chamber could not be exported back out"; fi

  echo
  down
  local after
  after=$(status) && ok "cleanup: $after" || bad "cleanup: $after"

  echo "$pass passed, $fail failed$([ "$inconclusive" = 1 ] && echo ", control inconclusive")"
  [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]
}

run() {
  [ -n "${1:-}" ] || { echo "usage: n8n-chamber.sh run <dir-of-faked-workflows> [export-dir]"; return 2; }
  EXPORT_TO="${2:-}"
  trap finish EXIT
  trap 'echo; echo "Stopping the chamber..."; exit 0' INT TERM
  echo "Starting the chamber (image $IMAGE)..."
  up "$1" || { echo "Could not start the chamber. Is Docker Desktop running and the image pulled?"; return 1; }
  wait_ready || { echo "The editor did not start. Logs: docker logs $APP"; return 1; }
  local n
  n=$(ls "$1"/*.json 2>/dev/null | wc -l | tr -d ' ')
  echo "Imported $n faked test workflow(s) as \"[test] ...\"."
  echo "Nothing in the chamber can reach the internet, your network or your files."
  # Create the throwaway owner account so there is no sign-up form. Local only, deleted with the chamber.
  OWNER_REPLY=""
  if create_owner; then
    echo "Open http://127.0.0.1:$PORT and sign in with:  chamber@example.com  /  Chamber1234"
    echo "(a throwaway local login; it is deleted with the chamber. If the page still shows sign-up, refresh the tab.)"
  else
    echo "Open http://127.0.0.1:$PORT  (the first visit asks you to create a throwaway local account)"
    echo "(could not create it automatically; n8n said: $OWNER_REPLY)"
  fi
  echo "Open a \"[test] ...\" workflow and click Execute workflow. Changes save automatically a moment after you stop editing; wait a couple of seconds, then press Ctrl+C to save your edits to a folder and delete the chamber."
  sleep 2147483647 & wait $!
}

case "${1:-}" in
  proof) proof ;;
  run)   run "${2:-}" "${3:-}" ;;
  up)    up "${2:-}" && wait_ready && echo "Chamber is up: http://127.0.0.1:$PORT   (stop it with: ./scripts/n8n-chamber.sh down)" ;;
  down)  down; echo "Chamber removed."; status ;;
  status) status ;;
  *)     echo "usage: n8n-chamber.sh <proof|run <dir> [export-dir]|up [dir]|down|status>"; exit 2 ;;
esac
