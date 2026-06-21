#!/bin/bash
# Self-healing Local-model tunnel supervisor.
# Keeps Ollama + a cloudflared tunnel to it alive 24/7, and on every (re)start syncs
# the new public URL into the deployed app's engine_settings (local_endpoint) so
# Local mode never silently breaks. Designed for an always-on box.
#   - --http-host-header localhost:11434  → avoids Ollama's blank 403 on a non-local Host
#   - --protocol http2                    → avoids the intermittent QUIC connection drops
set +e
# cd to the repo root relative to this script (portable — works on any box).
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 1
set -a; . .secrets/supabase.env; set +a   # load SUPABASE_* (never echoed)
LOG=/tmp/cf-supervisor.log
MODEL="qwen2.5:1.5b"
echo "$(date -u) supervisor start" >> "$LOG"

while true; do
  # 1. ensure Ollama is serving
  if ! curl -s --max-time 5 http://localhost:11434/api/version >/dev/null 2>&1; then
    echo "$(date -u) ollama down, starting" >> "$LOG"
    nohup ollama serve >/tmp/ollama.log 2>&1 &
    sleep 4
  fi
  # keep the model RESIDENT (keep_alive:-1) so there's no cold-load latency that would
  # blow the cross-region request timeout — this is what makes Local answer reliably.
  curl -s --max-time 60 http://localhost:11434/api/chat -H 'content-type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"warm\"}],\"stream\":false,\"keep_alive\":-1}" >/dev/null 2>&1

  # 2. (re)start the tunnel, capture its URL
  CF_LOG=/tmp/cf-current.log; : > "$CF_LOG"
  cloudflared tunnel --url http://localhost:11434 --http-host-header localhost:11434 --protocol http2 > "$CF_LOG" 2>&1 &
  CF_PID=$!

  URL=""
  for i in $(seq 1 30); do
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" | head -1)
    [ -n "$URL" ] && break
    sleep 2
  done

  if [ -n "$URL" ]; then
    echo "$URL" > /tmp/tunnel-url.txt
    echo "$(date -u) tunnel up: $URL" >> "$LOG"
    node scripts/sync-local-endpoint.mjs "$URL/v1" "$MODEL" >> "$LOG" 2>&1
  else
    echo "$(date -u) no URL after 60s, killing + retry" >> "$LOG"
    kill -9 "$CF_PID" 2>/dev/null
    sleep 3
    continue
  fi

  # 3. block until the tunnel dies, then loop (re-sync the new URL)
  wait "$CF_PID"
  echo "$(date -u) tunnel exited, restarting" >> "$LOG"
  sleep 2
done
