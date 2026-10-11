#!/bin/sh
# Type-checks, validates and tests the mod against the Claude Code build on this Mac.
set -e
cd "$(dirname "$0")/.."
P=$(pwd)
CLAUDE=${CLAUDE_BIN:-$(ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1)}
[ -x "$CLAUDE" ] || CLAUDE=claude
TYPES=${CLAUDE_TYPES:-$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1)}
TSC=${TSC:-$(ls -t "$HOME"/.npm/_npx/*/node_modules/typescript/bin/tsc 2>/dev/null | head -1)}
status=0
if [ -n "$TSC" ] && [ -n "$TYPES" ]; then
  T=$(mktemp -d)
  cat > "$T/tsconfig.json" <<JSON
{ "compilerOptions": { "target": "es2023", "lib": ["es2023"], "module": "esnext", "moduleResolution": "bundler",
  "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true,
  "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment", "types": [] },
  "include": ["$TYPES", "$P/hooks", "$P/types", "$P/tests"] }
JSON
  node "$TSC" -p "$T/tsconfig.json" || status=1
  rm -rf "$T"
else
  echo "(no tsc or types file: skipped type-check; load the plugin-authoring skill once, or set TSC / CLAUDE_TYPES)"
fi
"$CLAUDE" plugin validate "$P" || status=1
"$CLAUDE" plugin test "$P" || status=1
exit $status
