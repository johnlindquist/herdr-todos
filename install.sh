#!/bin/sh
# Copies Todos and its right-click menu into the Herdr app's mods folder (default
# ~/.config/herdr-app, or $HERDR_APP_HOME) and checks them: todos and todos-menu.
set -e
command -v herdr-app >/dev/null 2>&1 || { echo "install: herdr-app was not found on your PATH. Install the Herdr app first: https://herdr.dev/" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "install: node was not found on your PATH. Todos needs Node 22 or newer." >&2; exit 1; }
src="$(cd "$(dirname "$0")" && pwd)"
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mkdir -p "$mods/todos/icons" "$mods/todos-menu"
cp "$src"/main.js "$src"/nav.js "$src"/todos.mjs "$src"/mod.json "$mods/todos/"
cp "$src"/icons/*.svg "$mods/todos/icons/"
cp "$src"/menu/main.js "$src"/menu/mod.json "$mods/todos-menu/"
herdr-app check "$mods/todos"
herdr-app check "$mods/todos-menu"
echo "Installed Todos and its menu into $mods"
echo "Todos docks on the right the first time Herdr sees it. Its companion, Memories: https://github.com/johnlindquist/herdr-memories"
