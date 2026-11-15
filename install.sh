#!/bin/sh
# Copies Todos, Memories and their menu into the Herdr app's mods folder (default ~/.config/herdr-app, or $HERDR_APP_HOME)
# and checks them: todos (the task lists and the helper both use), memories, and todos-menu
# (the right-click menu both open).
set -e
command -v herdr-app >/dev/null 2>&1 || { echo "install: herdr-app was not found on your PATH. Install the Herdr app first: https://herdr.dev/" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "install: node was not found on your PATH. Todos and Memories need Node 22 or newer." >&2; exit 1; }
src="$(cd "$(dirname "$0")" && pwd)"
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mkdir -p "$mods/todos/icons" "$mods/memories/icons" "$mods/todos-menu"
cp "$src"/main.js "$src"/nav.js "$src"/todos.mjs "$src"/mod.json "$mods/todos/"
cp "$src"/icons/*.svg "$mods/todos/icons/"
cp "$src"/memories/main.js "$src"/memories/nav.js "$src"/memories/mod.json "$mods/memories/"
cp "$src"/memories/icons/*.svg "$mods/memories/icons/"
cp "$src"/menu/main.js "$src"/menu/mod.json "$mods/todos-menu/"
herdr-app check "$mods/todos"
herdr-app check "$mods/memories"
herdr-app check "$mods/todos-menu"
echo "Installed Todos, Memories and their menu into $mods"
echo "Todos docks on the right the first time Herdr sees it. To put Memories under it, open Herdr once, then run: node place-memories.mjs"
