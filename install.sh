#!/bin/sh
# Copies both mods into the Herdr app's mods folder (default ~/.config/herdr-app, or $HERDR_APP_HOME)
# and checks them: todos (the task lists and the helper both use), memories, and todos-menu
# (the right-click menu both open).
set -e
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
