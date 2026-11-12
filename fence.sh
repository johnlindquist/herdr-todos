#!/bin/sh
# The Fence: syntax of every module, types of the shared navigation rules, and the tests.
# (The views' own tsc errors predate this file; they are counted, not yet gated.)
set -e
cd "$(dirname "$0")"
for f in main.js memories/main.js menu/main.js nav.js memories/nav.js todos.mjs; do node --check "$f"; done
tsc --noEmit --allowJs --checkJs --strict --noImplicitAny false --target ES2022 --module ES2022 nav.js
node --test test/*.test.mjs
echo "fence: ok"
