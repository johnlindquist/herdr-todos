#!/usr/bin/env node
// Puts the Memories widget under the Todos widget in a Herdr layout file.
//
//   node place-memories.mjs                 the layout the window shows now
//   node place-memories.mjs <layout.json>   that file
//
// Herdr docks Todos on the right by itself the first time it sees the mod. Memories has no dock
// spot of its own: this wraps the Todos block in a column and adds Memories below it, with a line
// between them that can be dragged. Running it again changes nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const shows = (node, mod) => node?.content && typeof node.content === "object" && node.content.mod === mod;
function find(node, mod) {
  if (!node || typeof node !== "object") return null;
  if (shows(node, mod)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, mod);
    if (hit) return hit;
  }
  return null;
}

/**
 * The layout with Memories under Todos. Pure: returns { layout, result } and never changes its input.
 * result: "placed" | "already" (Memories is in the layout) | "no-todos" (Todos is not in the layout).
 */
export function placeMemories(layout) {
  if (find(layout, "memories")) return { layout, result: "already" };
  if (!find(layout, "todos")) return { layout, result: "no-todos" };
  const memories = { id: "memories", type: "block", content: { mod: "memories" }, size: { weight: 2 }, min: 120 };
  const walk = (node, parent) => {
    if (!node || typeof node !== "object") return node;
    if (shows(node, "todos")) {
      const todos = { ...node, size: { weight: 3 }, min: 140 };
      // Already stacked with other widgets: Memories goes right after Todos.
      if (parent?.type === "column") return [todos, memories];
      const width = node.size && typeof node.size.px === "number" ? node.size : { px: 304 };
      return { id: "right-panel", type: "column", size: width, divider: { width: 1, color: "border" }, children: [todos, memories] };
    }
    if (!Array.isArray(node.children)) return node;
    return { ...node, children: node.children.flatMap((c) => walk(c, node)) };
  };
  return { layout: walk(layout, null), result: "placed" };
}

function shownLayoutFile() {
  const home = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
  const status = JSON.parse(execFileSync("herdr-app", ["status"], { encoding: "utf8" }));
  if (typeof status.layout !== "string") throw new Error("herdr-app status did not name the shown layout; pass the layout file instead");
  return path.join(home, "layouts", `${status.layout}.json`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  try {
    const file = process.argv[2] ? path.resolve(process.argv[2]) : shownLayoutFile();
    const { layout, result } = placeMemories(JSON.parse(fs.readFileSync(file, "utf8")));
    if (result === "placed") {
      fs.copyFileSync(file, `${file}.before-memories`);
      fs.writeFileSync(file, JSON.stringify(layout, null, 2) + "\n");
      console.log(`Memories is now under Todos in ${file} (the file as it was: ${file}.before-memories)`);
    } else if (result === "already") console.log(`Memories is already in ${file}; nothing changed`);
    else {
      console.error(`Todos is not in ${file} yet. Open Herdr once after ./install.sh so Todos docks on the right, then run this again.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`place-memories: ${e.message}`);
    process.exit(1);
  }
}
