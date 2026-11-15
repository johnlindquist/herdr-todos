import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { step, widgetDirection, blockOf, collapseResize, applyCollapse, loadCollapsed, returnTarget, tip, HEADER_PX } from "../nav.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const LAYOUT = { type: "row", children: [{ id: "main", type: "block" }, { id: "right-panel", type: "column", children: [
  { id: "t1", type: "block", content: { mod: "todos" }, size: { weight: 3 }, min: 140 },
  { id: "memories", type: "block", content: { mod: "memories" }, size: { weight: 2 } },
  { id: "iss", type: "block", content: { mod: "triage" }, size: { weight: 3 } }] }, { id: "solo", type: "block", content: { mod: "alone" }, size: { px: 300 } }] };

test("arrows stay inside the widget: no wrap, no jump past the ends", () => {
  assert.equal(step(4, 5, "down"), 4);
  assert.equal(step(0, 5, "up"), 0);
  assert.equal(step(2, 5, "j"), 3);
  assert.deepEqual([step(2, 9, "home"), step(2, 9, "end"), step(1, 9, "pagedown"), step(8, 9, "pagedown"), step(3, 9, "pageup")], [0, 8, 6, 8, 0]);
  assert.equal(step(0, 0, "down"), null);
  assert.equal(step(0, 5, "c"), null);
});

test("Tab and Shift+Tab move between widgets; nothing else does", () => {
  assert.deepEqual([widgetDirection("tab"), widgetDirection("shift-tab"), widgetDirection("down")], ["down", "up", null]);
});

test("collapse persists, gives height away when stacked, and restores the size the person had", () => {
  const s = store();
  const calls = [];
  const run = (n, a) => calls.push([n, a]);
  applyCollapse({ mod: "triage", collapsed: true, storage: s, layout: () => LAYOUT, run });
  assert.equal(loadCollapsed(s, "triage"), true);
  assert.deepEqual(calls[0], ["layout.resize", { id: "iss", px: HEADER_PX }]);
  const after = JSON.parse(JSON.stringify(LAYOUT));
  after.children[1].children[2].size = { px: HEADER_PX };
  applyCollapse({ mod: "triage", collapsed: false, storage: s, layout: () => after, run });
  assert.deepEqual(calls[1], ["layout.resize", { id: "iss", weight: 3 }]);
  assert.equal(loadCollapsed(s, "triage"), false);
  assert.equal(collapseResize(blockOf(LAYOUT, "alone"), true), null, "a block alone in a row is not resized");
  assert.equal(blockOf(LAYOUT, "nope"), null);
});

test("Esc returns to the pane that had the keyboard, else Main", () => {
  assert.deepEqual(returnTarget({ pane: "p1", terminal: "t1" }, "p9"), { pane: "p1" });
  assert.deepEqual(returnTarget(null, "p9"), { pane: "p9" });
  assert.equal(returnTarget(null, null), null);
  assert.equal(tip("Send to Main", "M"), "Send to Main (M)");
});

test("every widget carries the same navigation rules (copies match)", () => {
  const mine = fs.readFileSync(path.join(here, "..", "nav.js"), "utf8");
  // Sibling checkouts of the other widgets that share these rules are compared when they are there.
  const others = ["herdr-todos", "herdr-memories", "herdr-issues", "herdr-triage"].map((r) => path.join(here, "..", "..", r, "nav.js")).filter((f) => fs.existsSync(f));
  for (const f of others) assert.ok(fs.readFileSync(f, "utf8") === mine, `${f} differs from this copy`);
});

test("selection stays in view: the list moves only when the selection would leave it", async () => {
  const { keepInView, fitCount, wheelTop, maxTop, estimateViewport } = await import("../nav.js");
  const h = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
  assert.equal(fitCount(h, 0, 160), 3);
  assert.equal(keepInView(0, 2, h, 160), 0, "already visible: no scroll");
  assert.equal(keepInView(0, 3, h, 160), 1, "one past the bottom: scroll by one");
  assert.equal(keepInView(0, 9, h, 160), 7, "End: last item at the bottom");
  assert.equal(keepInView(7, 4, h, 160), 4, "above the top: it becomes the top");
  assert.equal(keepInView(0, 0, [400, 50], 160), 0, "an item taller than the list still shows from its start");
  assert.equal(maxTop(h, 160), 7);
  assert.equal(wheelTop(0, -40, h, 160), 1);
  assert.equal(wheelTop(7, -400, h, 160), 7, "the wheel stops at the end");
  assert.equal(wheelTop(1, 120, h, 160), 0);
  const tree = { type: "column", children: [{ content: { mod: "a" }, size: { weight: 3 } }, { content: { mod: "b" }, size: { px: 36 } }, { content: { mod: "c" }, size: { weight: 1 } }] };
  assert.equal(estimateViewport(tree, "a", 1036, 100), 650);
  assert.equal(estimateViewport(tree, "zzz", 900, 100), 200);
});
