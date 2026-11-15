import { test } from "node:test";
import assert from "node:assert/strict";
import { placeMemories } from "../place-memories.mjs";

const docked = () => ({ id: "root", type: "row", children: [{ id: "work", type: "column", children: [{ id: "main", type: "block", content: { tab: "active" } }] }, { id: "abc", type: "block", size: { px: 304 }, content: { mod: "todos" } }] });

test("a Todos block docked on the right becomes a column with Memories under it", () => {
  const before = docked();
  const { layout, result } = placeMemories(before);
  assert.equal(result, "placed");
  assert.deepEqual(before, docked(), "the input is not changed");
  const col = layout.children[1];
  assert.deepEqual([col.type, col.size, col.children.map((c) => c.content.mod)], ["column", { px: 304 }, ["todos", "memories"]]);
  assert.equal(col.children[0].id, "abc", "Todos keeps its id");
  assert.deepEqual(layout.children[0], before.children[0], "the rest of the layout is untouched");
});

test("Todos already stacked in a column gets Memories right after it", () => {
  const l = { type: "row", children: [{ id: "side", type: "column", children: [{ id: "t", type: "block", content: { mod: "todos" } }, { id: "x", type: "block", content: { mod: "other" } }] }] };
  const { layout } = placeMemories(l);
  assert.deepEqual(layout.children[0].children.map((c) => c.content.mod), ["todos", "memories", "other"]);
});

test("running it twice changes nothing; a layout without Todos is refused", () => {
  const once = placeMemories(docked()).layout;
  assert.deepEqual(placeMemories(once), { layout: once, result: "already" });
  assert.equal(placeMemories({ type: "row", children: [] }).result, "no-todos");
});
