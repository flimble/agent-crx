#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.local/bin/agent-crx"
mkdir -p "$HOME/.local/bin"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  echo "Warning: $TARGET exists and is not a symlink. Skipping."
  exit 1
fi
ln -sf "$SCRIPT_DIR/dist/index.js" "$TARGET"
chmod +x "$SCRIPT_DIR/dist/index.js"
echo "Installed: $TARGET -> $SCRIPT_DIR/dist/index.js"
