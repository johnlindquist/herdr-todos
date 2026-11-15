import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Some code is the same in herdr-todos and herdr-memories, copied so each repository can be read
// alone: nav.js, menu/main.js, and the shared block inside each helper. When the other repository
// is checked out beside this one, the copies must match byte for byte.
const here = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const other = path.join(here, "..", "herdr-memories");
const sharedBlock = (file) => {
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf("// >>> shared block");
  const b = text.indexOf("// <<< shared block");
  assert.ok(a >= 0 && b > a, `${file} has no shared block`);
  return text.slice(a, b);
};

test("this helper has its shared block", () => {
  assert.ok(sharedBlock(path.join(here, "todos.mjs")).length > 10_000);
});

test("shared copies match the herdr-memories checkout beside this one", { skip: !fs.existsSync(path.join(other, "memories.mjs")) && "no ../herdr-memories checkout" }, () => {
  assert.ok(sharedBlock(path.join(here, "todos.mjs")) === sharedBlock(path.join(other, "memories.mjs")), "the shared block differs");
  for (const f of ["nav.js", "menu/main.js"]) assert.ok(fs.readFileSync(path.join(here, f), "utf8") === fs.readFileSync(path.join(other, f), "utf8"), `${f} differs`);
});
