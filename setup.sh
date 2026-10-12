#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "  BravoGen Multi-Account MCP Server Setup & Self-Host"
echo "=========================================================="

# Check node or bun
if command -v bun >/dev/null 2>&1; then
    RUNTIME="bun"
elif command -v node >/dev/null 2>&1; then
    RUNTIME="node"
else
    echo "[!] Error: Neither Node.js nor Bun was found on this system."
    echo "    Please install Node.js >= 20 or Bun >= 1.0."
    exit 1
fi

echo "[+] Detected runtime: $RUNTIME"

# Check accounts.json or create from template
if [ ! -f "accounts.json" ] && [ ! -f ".env" ]; then
    echo "[*] Creating accounts.json from template..."
    cp accounts.example.json accounts.json
    echo "[!] Please edit accounts.json with your company credentials!"
else
    echo "[+] Configuration file found."
fi

# Build project
echo "[*] Building MCP bundle..."
if [ "$RUNTIME" = "bun" ]; then
    bun run build
else
    npm run build
fi

echo "[+] Build complete: dist/index.js"

# Run smoke test
echo "[*] Running smoke test across configured accounts..."
if [ "$RUNTIME" = "bun" ]; then
    bun run test/smoke_test.ts
else
    node dist/index.js < /dev/null || true
fi

echo "=========================================================="
echo "  BravoGen MCP is ready for self-hosting!"
echo ""
echo "  Run standalone:"
echo "    node bin/bravogen-mcp.js"
echo ""
echo "  Run with Docker:"
echo "    docker compose up -d"
echo "=========================================================="
