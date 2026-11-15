#!/bin/sh
# The Fence: syntax of every module, types of the shared navigation rules, and the tests.
# Needs TypeScript: run `npm install` here once (or have `tsc` on your PATH).
set -e
cd "$(dirname "$0")"
for f in main.js menu/main.js nav.js todos.mjs; do node --check "$f"; done
if [ -x node_modules/.bin/tsc ]; then tsc=node_modules/.bin/tsc
elif command -v tsc >/dev/null 2>&1; then tsc=tsc
else echo "fence: TypeScript is missing. Run: npm install" >&2; exit 1; fi
"$tsc" --noEmit --allowJs --checkJs --strict --noImplicitAny false --target ES2022 --module ES2022 nav.js
node --test test/*.test.mjs
echo "fence: ok"
