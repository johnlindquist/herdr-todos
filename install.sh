#!/bin/sh
# Copies both mods into the Herdr app's mods folder (default ~/.config/herdr-app, or $HERDR_APP_HOME)
# and checks them: todos (the task lists and the helper both use) and memories.
set -e
src="$(cd "$(dirname "$0")" && pwd)"
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mkdir -p "$mods/todos/icons" "$mods/memories/icons"
cp "$src"/main.js "$src"/todos.mjs "$src"/mod.json "$mods/todos/"
cp "$src"/icons/*.svg "$mods/todos/icons/"
cp "$src"/memories/main.js "$src"/memories/mod.json "$mods/memories/"
cp "$src"/memories/icons/*.svg "$mods/memories/icons/"
herdr-app check "$mods/todos"
herdr-app check "$mods/memories"
