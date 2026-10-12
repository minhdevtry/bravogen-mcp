#!/usr/bin/env bash
echo "========================================================"
echo "  KIỂM TRA KẾT NỐI VÀ HẠN MỨC BRAVOGEN MCP"
echo "========================================================"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$1" = "--full" ]; then
    node "$SCRIPT_DIR/test/smoke_test.ts" --full
else
    node "$SCRIPT_DIR/test/smoke_test.ts" --fast
fi
