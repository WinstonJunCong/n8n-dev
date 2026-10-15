#!/usr/bin/env bash
# n8n chamber: a sealed local n8n editor for playing with FAKED workflows.
#   ./scripts/n8n-chamber.sh proof   start the chamber, run the safety checks, tear it down
#   ./scripts/n8n-chamber.sh up      start the chamber and leave it running
#   ./scripts/n8n-chamber.sh down    remove it (containers, network and its data)
#
# One window in, no door out:
#   IN   your browser reaches the editor at 127.0.0.1 only, through a tiny forwarder container.
#   OUT  n8n runs on an INTERNAL Docker network: no route to the internet or your LAN, for any node.
#   DISK your repo is NOT mounted. n8n only sees its own throwaway volume.
# Everything is deleted on `down`, so nothing typed into the editor survives.
set -u
export MSYS_NO_PATHCONV=1                      # stop Git Bash on Windows rewriting /paths
IMAGE="n8nio/n8n:${N8N_VERSION:-2.43.4}"
PORT="${N8N_PORT:-5678}"
NET=n8n-chamber-net; APP=n8n-chamber-app; FWD=n8n-chamber-fwd; VOL=n8n-chamber-data

down() {
  docker rm -f "$FWD" "$APP" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  return 0
}

up() {
  down
  docker network create --internal "$NET" >/dev/null || return 1
  docker volume create "$VOL" >/dev/null || return 1
  # The editor: internal network only, no published port, no repo mount, no extra privileges.
  docker run -d --init --name "$APP" --network "$NET" \
    --cap-drop ALL --security-opt no-new-privileges --memory 1g \
    -v "$VOL":/home/node/.n8n \
    -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    -e N8N_TEMPLATES_ENABLED=false -e N8N_PERSONALIZATION_ENABLED=false \
    -e N8N_RUNNERS_ENABLED=true -e N8N_SECURE_COOKIE=false \
    -e N8N_RESTRICT_FILE_ACCESS_TO=/home/node/.n8n-files \
    -e NODES_EXCLUDE='["n8n-nodes-base.executeCommand","n8n-nodes-base.readWriteFile","n8n-nodes-base.localFileTrigger"]' \
    --entrypoint n8n "$IMAGE" start >/dev/null || return 1
  # The window: the only container with a published port, bound to loopback. It forwards inbound
  # connections to the editor and nothing else (same image, so there is nothing extra to download).
  docker run -d --init --name "$FWD" --cap-drop ALL --security-opt no-new-privileges --memory 128m \
    -p "127.0.0.1:${PORT}:5678" --entrypoint node "$IMAGE" -e \
    'const n=require("net");n.createServer(c=>{const s=n.connect(5678,"n8n-chamber-app");c.pipe(s);s.pipe(c);const k=()=>{c.destroy();s.destroy()};c.on("error",k);s.on("error",k);c.on("close",k);s.on("close",k)}).listen(5678,"0.0.0.0")' >/dev/null || return 1
  docker network connect "$NET" "$FWD" || return 1
}

wait_ready() {
  for _ in $(seq 1 90); do
    curl -fs "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# Exit code 0 = the address was reached, 1 = it was not (blocked, no DNS, or timed out).
PROBE='fetch(process.argv[1],{signal:AbortSignal.timeout(6000)}).then(()=>process.exit(0),()=>process.exit(1))'

proof() {
  local pass=0 fail=0 inconclusive=0
  ok()  { echo "PASS: $1"; pass=$((pass + 1)); }
  bad() { echo "FAIL: $1"; fail=$((fail + 1)); }
  trap down EXIT
  echo "Starting the chamber (image $IMAGE)..."
  up || { echo "Could not start the chamber. Is Docker Desktop running and the image pulled?"; exit 1; }

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

  echo
  echo "$pass passed, $fail failed$([ "$inconclusive" = 1 ] && echo ", control inconclusive")"
  [ "$fail" -eq 0 ] && [ "$inconclusive" -eq 0 ]
}

case "${1:-}" in
  proof) proof ;;
  up)    up && wait_ready && echo "Chamber is up: http://127.0.0.1:$PORT   (stop it with: ./scripts/n8n-chamber.sh down)" ;;
  down)  down && echo "Chamber removed." ;;
  *)     echo "usage: n8n-chamber.sh <proof|up|down>"; exit 2 ;;
esac
