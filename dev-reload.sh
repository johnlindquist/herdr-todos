#!/bin/sh
# Development: install, then restart the shown copy by bumping its block's props.rev in the
# shown layout (a block given new props starts over), for when hot reload doesn't pick a change up.
set -e
"$(dirname "$0")"/install.sh
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
layout="$(herdr-app status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).layout))')"
node -e '
const fs = require("fs"); const f = process.argv[1];
const d = JSON.parse(fs.readFileSync(f, "utf8"));
let hit = 0;
(function walk(n) { if (n?.content?.mod === "todos") { n.content.props = { ...(n.content.props || {}), rev: Date.now() }; hit++; } (n?.children || []).forEach(walk); })(d);
if (hit) fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
console.log(hit ? "restarted todos in " + f : "todos is not in " + f);
' "$home/layouts/$layout.json"
