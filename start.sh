#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-8787}"

# Start the MCP server in the background
echo "Starting Voice Agent MCP server on port $PORT..."
node server.js &
SERVER_PID=$!

# Give the server a moment to start
sleep 2

# Start cloudflared tunnel
echo "Starting cloudflared tunnel..."
cloudflared tunnel --url "http://localhost:$PORT" &
TUNNEL_PID=$!

# Trap to clean up both processes
cleanup() {
    echo "Shutting down..."
    kill "$SERVER_PID" 2>/dev/null || true
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait
}
trap cleanup EXIT INT TERM

echo "Voice Agent MCP is running. Press Ctrl+C to stop."
wait
