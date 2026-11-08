#!/bin/sh
# Copies the mod into the Herdr app's mods folder (default ~/.config/herdr-app, or $HERDR_APP_HOME).
set -e
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/todos"
mkdir -p "$dest/icons"
cp "$(dirname "$0")"/main.js "$(dirname "$0")"/todos.mjs "$(dirname "$0")"/mod.json "$dest/"
cp "$(dirname "$0")"/icons/*.svg "$dest/icons/"
herdr-app check "$dest"
