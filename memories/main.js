// Memories: rules worth keeping, suggested from your own prompts in the shown space's Pi sessions.
// Keep one and <project>/MEMORIES.md (linked from AGENTS.md) is rewritten to include it; dismiss it and
// it is never suggested again. Everything goes through the todos helper (mods/todos/todos.mjs),
// which finds the suggestions while it updates the task lists.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { focused, exec, home, appHome, theme, watchFolder, shared, panes, run, openOverlay, nextCommand, layout } from "herdr";
import { step, widgetDirection, COLLAPSE_KEY, loadCollapsed, applyCollapse, returnTarget, tip, keepInView, wheelTop, maxTop, fitCount, estimateViewport } from "./nav.js";

const NAME = "memories";
// Fixed heights: the list is virtual and places items by these; text is clipped to fit and the
// full text is in the tooltip (and Edit).
const H = { project: 24, suggestion: 128, quoted: 150, editing: 190, keptHeader: 30, keptRow: 46, keptEdit: 120, keptHeading: 22 };

const ICON = (n) => `mods/memories/icons/${n}.svg`;
const helper = () => `${appHome()}/mods/todos/todos.mjs`;
const stateDir = () => {
  const app = appHome();
  const key = app === `${home()}/.config/herdr-app` ? "default" : app.replace(/[^A-Za-z0-9]/g, "_");
  return `${home()}/.cache/herdr-todos/${key}`;
};
// Spaces on another machine ("m1/sp…") are read there: the helper is piped through herdr-core to
// that machine's Node, so its Pi journals, git roots, model logins and MEMORIES.md stay on it and
// both ends always run this same version of the helper.
const REMOTE_STATE = "~/.cache/herdr-todos/remote";
const where = (space) => {
  const i = space.indexOf("/");
  return i < 0 ? { machine: null, id: space } : { machine: space.slice(0, i), id: space.slice(i + 1) };
};
function callHelper(machine, argv, timeout) {
  if (!machine) return exec("node", [helper(), ...argv, "--state", stateDir()], { timeout });
  return exec("sh", ["-c", 'm="$1"; shift; exec hc exec --on "$m" -i node --input-type=module - "$@" < "$0"', helper(), machine, ...argv, "--state", REMOTE_STATE], { timeout });
}
function helperError(r, machine) {
  const text = r.stderr.trim();
  if (machine && /cannot start node|node: (command )?not found|exec: node/i.test(text)) return `${machine} needs Node and Pi for Memories`;
  try {
    const e = JSON.parse(text.split("\n").pop());
    return typeof e.message === "string" ? e.message : e.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || `exit ${r.code}`;
  }
}
// The right-click menu is the todos-menu mod; the choice comes back as the "menu" command with
// shared "memories.menu" = { action, args, at }.
const CHROME = (n) => `mods/workspace-chrome/${n}.svg`;
function openMenu(title, items) {
  const seps = items.filter((it, i) => i > 0 && it.sep).length;
  openOverlay({ mod: "todos-menu", kind: "popup", width: 250, height: 12 + items.length * 31 + seps * 9 + (title ? 24 : 0), props: { owner: "memories", title, items } });
}
// Opens argv in a new pane right of the terminal's pane (else the focused one), unzooming first.
function splitBeside(terminal, argv) {
  const all = panes();
  const f = focused();
  const target = (terminal && all.find((p) => p.terminal === terminal)) ?? all.find((p) => p.pane === f?.pane) ?? all.find((p) => p.tab === f?.tab && p.terminal);
  if (!target) return "No pane to open it beside";
  const zoomed = all.find((p) => p.tab === target.tab && p.zoomed);
  if (zoomed) run("pane.zoom", { pane: zoomed.pane });
  run("pane.split", { pane: target.pane, direction: "right", argv });
  return null;
}

const spaceKey = (space) => space.replace(/[^A-Za-z0-9_-]/g, "_");

const KIND = {
  decision: { label: "Decision", color: (t) => t.accent },
  preference: { label: "Preference", color: (t) => t.ansi5 ?? t.accent },
  correction: { label: "Correction", color: (t) => t.blocked },
};

function ago(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The list shows items from `top` and clips the rest; ↑/↓ and the wheel move `top` only as
// needed (the rules and their tests are in nav.js). Shared shape across the three widgets.
function windowedList(view, t, id, heights, render, chromePx, mod) {
  const vp = view.viewH ?? estimateViewport(layout(), mod, windowHeight(), chromePx);
  view.lastHeights = heights;
  view.lastVp = vp;
  view.top = Math.min(view.top ?? 0, maxTop(heights, vp));
  const shown = fitCount(heights, view.top, vp);
  const more = heights.length > shown;
  const list = div()
    .id(id)
    .flex_1()
    .min_h(60)
    .overflow_hidden()
    .relative()
    .on_mouse_move((e) => {
      if (e.bounds?.height) view.viewH = e.bounds.height;
    })
    .on_scroll_wheel((e, cx) => {
      if (e.bounds?.height) view.viewH = e.bounds.height;
      view.top = wheelTop(view.top, e.delta.y, heights, view.viewH ?? vp);
      cx.notify();
    })
    .child(v_flex().children(heights.slice(view.top, view.top + shown + 1).map((h, j) => div().h(h).flex_none().child(render(view.top + j)))));
  return v_flex()
    .flex_1()
    .min_h(76)
    .child(list)
    .when(more, (el) => el.child(div().flex_none().h(16).px(14).text_size(10).text_color(t.dim).child(`Showing ${view.top + 1}–${Math.min(heights.length, view.top + shown)} of ${heights.length} · scroll or ↑↓`)));
}

const windowHeight = () => {
  try {
    return /** @type {any} */ (globalThis).window?.viewport_size?.().height ?? 900;
  } catch {
    return 900;
  }
};

// The key legend under the list (the same shape in Issues, Todos and Memories).
function legend(t, keys) {
  return h_flex()
    .flex_none()
    .px(12)
    .py(5)
    .gap_x(8)
    .gap_y(3)
    .flex_wrap()
    .border_t(1)
    .border_color(t.border)
    .children(
      keys.map(([k, label]) =>
        h_flex()
          .id(`legend-${label}`)
          .gap(4)
          .items_center()
          .tooltip(tip({ Next: "Next widget", Back: "Back to Main", Select: "Select" }[label] ?? label, k))
          .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.foreground).child(k))
          .child(div().text_size(10.5).text_color(t.dim).child(label)),
      ),
    );
}

export default class Memories extends View {
  init(_props, cx) {
    this.cache = {}; // space id -> projects from the helper
    this.errors = {};
    this.space = null;
    this.editing = null; // { id, root, state }
    this.keptOpen = false;
    this.undo = null; // the last dismissed or removed memory
    this.hidden = new Set(); // ids acted on here, hidden until the helper confirms
    this.loading = false;
    this.seenUpdate = {};
    this.collapsed = loadCollapsed(localStorage, NAME);
    this.handle = cx.focus_handle();
    this.top = 0;
    this.viewH = null;
    this.lastHeights = null; // the list's row heights and height, from the last render
    this.lastVp = 0;
    this.sel = null; // selected item key
    this.before = null;
    this.items = []; // the virtual list's items, from the last render
    this.tick(cx);
    cx.timer.every(2000, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "menu") this.menuChoice(cx);
        else if (c === "focus") this.takeKeyboard();
        else this.command(c, cx);
        cx.notify();
      }
    });
    cx.timer.every(60_000, (cx) => cx.notify()); // ages
    // The helper writes suggestions while updating task lists: reload when its state changes.
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${stateDir()}/memories`, `${stateDir()}/spaces`]).catch(() => {});
      for (;;) {
        let changed;
        try {
          changed = await watchFolder(stateDir());
        } catch {
          return;
        }
        const sp = this.space;
        if (sp && changed.some((p) => p.includes("/memories/") || p.endsWith(`/spaces/${spaceKey(sp)}.json`) || p === stateDir())) this.load(sp, cx);
      }
    });
  }

  tick(cx) {
    const sp = focused()?.space ?? null;
    if (sp && sp !== this.space) {
      this.space = sp;
      this.editing = null;
      this.load(sp, cx);
      cx.notify();
    }
    // Todos says when it updated a space (on another machine there's no folder to watch).
    const at = sp ? shared("todos.updated")?.[sp] : null;
    if (at && at !== this.seenUpdate[sp]) {
      const first = this.seenUpdate[sp] === undefined;
      this.seenUpdate[sp] = at;
      if (!first) this.load(sp, cx);
    }
  }

  load(space, cx) {
    const { machine, id } = where(space);
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await callHelper(machine, ["memories", "--space", id], 60_000);
        if (r.code === 0) {
          this.cache[space] = JSON.parse(r.stdout).projects;
          delete this.errors[space];
          this.hidden.clear();
        } else this.errors[space] = helperError(r, machine);
      } catch (e) {
        this.errors[space] = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  message(r) {
    try {
      return JSON.parse(r.stderr.trim()).message;
    } catch {
      return r.stderr.trim().slice(0, 160) || `exit ${r.code}`;
    }
  }

  act(action, root, m, cx, text) {
    const sp = this.space;
    if (action !== "edit") this.hidden.add(m.id);
    if (action === "dismiss" || action === "remove") this.undo = { root, id: m.id, text: m.text, action };
    else if (action === "accept") this.undo = null;
    this.editing = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const { machine } = where(sp);
      const argv = ["memory", action, "--root", root, "--id", m.id];
      if (text != null) argv.push("--text", text);
      try {
        const r = await callHelper(machine, argv, 60_000);
        if (r.code !== 0) {
          this.hidden.delete(m.id);
          this.errors[sp] = helperError(r, machine);
        }
      } catch (e) {
        this.hidden.delete(m.id);
        this.errors[sp] = String(e?.message ?? e);
      }
      if (sp) this.load(sp, cx);
      cx.notify();
    });
  }

  startEdit(root, m, cx) {
    const state = TextareaState.new({ value: m.text });
    state.set_auto_grow(2, 6);
    state.set_soft_wrap(true);
    this.editing = { id: m.id, root, state };
    cx.notify();
    state.focus();
  }

  // ---------- right-click menus ----------

  suggestionMenu(p, m) {
    const items = [
      { label: "Explain where it came from", icon: CHROME("panel-right"), action: "explain", args: { root: p.root, id: m.id } },
      { label: "Keep", icon: ICON("check"), action: "accept", args: { root: p.root, id: m.id }, sep: true },
      { label: "Edit", icon: ICON("pencil"), action: "edit", args: { root: p.root, id: m.id } },
      { label: "Dismiss", icon: ICON("x"), action: "dismiss", args: { root: p.root, id: m.id } },
    ];
    if (m.source?.terminal) items.push({ label: "Go to its session", icon: CHROME("terminal"), action: "focus", args: { terminal: m.source.terminal }, sep: true });
    openMenu(m.text, items);
  }

  keptMenu(p, it) {
    const id = it.ids.join(",");
    const text = it.label ? `${it.label}: ${it.text}` : it.text;
    openMenu(text, [
      { label: "Explain where it came from", icon: CHROME("panel-right"), action: "explain", args: { root: p.root, id } },
      { label: "Edit wording", icon: ICON("pencil"), action: "edit-kept", args: { root: p.root, id }, sep: true },
      { label: it.ids.length > 1 ? `Remove (${it.ids.length} merged)` : "Remove", icon: ICON("x"), action: "remove", args: { root: p.root, id }, danger: true },
    ]);
  }

  find(root, id) {
    const p = (this.cache[this.space] ?? []).find((x) => x.root === root);
    if (!p) return null;
    const m = p.pending.find((x) => x.id === id);
    if (m) return { p, m };
    const it = (p.kept ?? []).flatMap((sec) => sec.items).find((x) => x.ids.join(",") === id);
    return it ? { p, it } : null;
  }

  // ---------- keyboard: the shared rules in nav.js ----------

  takeKeyboard() {
    const f = focused();
    if (!this.handle.is_focused() && f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
    if (this.collapsed) this.setCollapsed(false);
    this.handle.focus();
    this.reveal();
  }

  setCollapsed(on) {
    this.collapsed = on;
    applyCollapse({ mod: NAME, collapsed: on, storage: localStorage, layout, run });
  }

  selectable() {
    return this.items.filter((x) => x.select);
  }

  reveal() {
    const at = this.items.findIndex((x) => x.key === this.sel);
    if (at >= 0 && this.lastHeights) this.top = keepInView(this.top, at, this.lastHeights, this.lastVp);
  }

  /** Keys and commands share one path. Returns true when handled. */
  command(k, cx) {
    if (this.editing) return false; // typing in the editor
    if (k === "escape") {
      const t = returnTarget(this.before, null);
      this.before = null;
      if (t) run("pane.focus", t);
      return true;
    }
    if (k === COLLAPSE_KEY || k === "collapse") return (this.setCollapsed(!this.collapsed), true);
    const dir = widgetDirection(k);
    if (dir) return (run("pane.go", { direction: dir }), true);
    if (this.collapsed) return false;
    const list = this.selectable();
    const at = Math.max(0, list.findIndex((x) => x.key === this.sel));
    const next = step(at, list.length, k);
    if (next != null) {
      this.sel = list[next].key;
      this.reveal();
      return true;
    }
    const cur = list[at];
    if (!cur) return false;
    if (cur.kind === "suggestion") {
      if (k === "enter") return (this.act("accept", cur.p.root, cur.m, cx), true);
      if (k === "e") return (this.startEdit(cur.p.root, cur.m, cx), true);
      if (k === "d") return (this.act("dismiss", cur.p.root, cur.m, cx), true);
      if (k === "shift-f10") return (this.suggestionMenu(cur.p, cur.m), true);
    } else if (cur.kind === "keptHeader" && (k === "enter" || k === "space")) {
      this.keptOpen = !this.keptOpen;
      return true;
    } else if (cur.kind === "kept") {
      if (k === "e") return (this.startEdit(cur.p.root, { id: cur.it.ids.join(","), text: cur.it.text }, cx), true);
      if (k === "d" || k === "delete" || k === "backspace") return (this.act("remove", cur.p.root, { id: cur.it.ids.join(","), text: cur.it.label ? `${cur.it.label}: ${cur.it.text}` : cur.it.text }, cx), true);
      if (k === "shift-f10") return (this.keptMenu(cur.p, cur.it), true);
    }
    return false;
  }

  menuChoice(cx) {
    const c = shared("memories.menu");
    if (!c || c.at === this.menuSeen) return;
    this.menuSeen = c.at;
    const { root, id, terminal } = c.args ?? {};
    const machine = this.space ? where(this.space).machine : null;
    const full = (t) => (t && machine && !t.startsWith(`${machine}/`) ? `${machine}/${t}` : t);
    if (c.action === "explain") return this.explain(root, id, cx);
    if (c.action === "focus") {
      const pane = panes().find((x) => x.terminal === full(terminal))?.pane;
      if (pane) run("pane.focus", { pane });
      else run("agent.focus", { terminal: full(terminal) });
      return;
    }
    const hit = this.find(root, id);
    if (!hit) return;
    if (c.action === "edit" && hit.m) this.startEdit(root, hit.m, cx);
    else if (c.action === "edit-kept" && hit.it) {
      this.keptOpen = true;
      this.startEdit(root, { id, text: hit.it.text }, cx);
    } else if ((c.action === "accept" || c.action === "dismiss") && hit.m) this.act(c.action, root, hit.m, cx);
    else if (c.action === "remove" && hit.it) this.act("remove", root, { id, text: hit.it.label ? `${hit.it.label}: ${hit.it.text}` : hit.it.text }, cx);
  }

  // A new Pi beside the session the memory came from, on a fork of that conversation, asked to
  // explain it and given the keep/dismiss/reword commands (`explain` in todos.mjs).
  explain(root, id, cx) {
    const sp = this.space;
    if (!sp || !root || !id) return;
    const { machine } = where(sp);
    this.notice = "Opening a Pi to explain…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await callHelper(machine, ["explain", "--root", root, "--memory", id], 60_000);
        if (r.code !== 0) this.errors[sp] = `Couldn't open: ${helperError(r, machine)}`;
        else {
          const out = JSON.parse(r.stdout);
          const t = out.terminal && machine ? `${machine}/${out.terminal}` : out.terminal;
          const why = splitBeside(t, out.argv);
          if (why) this.errors[sp] = why;
          else delete this.errors[sp];
        }
      } catch (e) {
        this.errors[sp] = `Couldn't open: ${String(e?.message ?? e)}`;
      }
      this.notice = null;
      cx.notify();
    });
  }

  // ---------- drawing ----------

  button(t, id, label, icon, kind, onClick) {
    const primary = kind === "primary";
    return h_flex()
      .id(id)
      .h(24)
      .px(8)
      .gap(5)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .tooltip({ Keep: tip("Keep: add to MEMORIES.md", "Enter"), Edit: tip("Edit wording", "E"), Dismiss: tip("Dismiss", "D"), Save: "Save wording", Cancel: "Cancel editing" }[label] ?? label)
      .text_size(11.5)
      .font_medium()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(12)))
      .child(label);
  }

  suggestion(t, p, m) {
    const kind = KIND[m.kind] ?? KIND.preference;
    const editing = this.editing?.id === m.id ? this.editing : null;
    const id = `mem-${m.id}`;
    const body = editing
      ? div()
          .id(`${id}-edit`)
          .rounded(6)
          .border(1)
          .border_color(t.accent)
          .bg(t.background)
          .px(8)
          .py(5)
          .text_size(12.5)
          .text_color(t.foreground)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(editing.state).w_full().text_size(12.5).text_color(t.foreground))
      : div().h(36).overflow_hidden().whitespace_normal().text_size(12.5).text_color(t.foreground).child(m.text);
    const actions = editing
      ? [
          this.button(t, `${id}-save-keep`, "Keep", "check", "primary", (cx) => this.act("accept", p.root, m, cx, editing.state.value())),
          this.button(t, `${id}-save`, "Save", null, "plain", (cx) => this.act("edit", p.root, m, cx, editing.state.value())),
          this.button(t, `${id}-cancel`, "Cancel", null, "plain", (cx) => {
            this.editing = null;
            cx.notify();
          }),
        ]
      : [
          this.button(t, `${id}-keep`, "Keep", "check", "primary", (cx) => this.act("accept", p.root, m, cx)),
          this.button(t, `${id}-edit-btn`, "Edit", "pencil", "plain", (cx) => this.startEdit(p.root, m, cx)),
          this.button(t, `${id}-dismiss`, "Dismiss", "x", "plain", (cx) => this.act("dismiss", p.root, m, cx)),
        ];
    const selected = this.sel === `s:${m.id}` && this.handle.is_focused();
    return v_flex()
      .id(id)
      .flex_none()
      .h((editing ? H.editing : m.quote ? H.quoted : H.suggestion) - 8)
      .overflow_hidden()
      .p(10)
      .gap(6)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(selected ? t.accent : editing ? t.input : t.border)
      .tooltip(`${kind.label}: ${m.text}${m.quote ? `\nFrom your prompt: “${m.quote}”` : ""}\n\n${tip("Keep", "Enter")} · ${tip("Edit", "E")} · ${tip("Dismiss", "D")} · right-click for more`)
      .on_mouse_down("right", () => this.suggestionMenu(p, m))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().w(6).h(6).rounded(3).bg(kind.color(t)))
          .child(div().text_size(10.5).font_medium().text_color(kind.color(t)).child(kind.label))
          .child(div().flex_1())
          .when(Boolean(m.source?.session), (el) => el.child(div().max_w(130).truncate().text_size(10.5).text_color(t.dim).child(m.source.session)))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(m.created_at))),
      )
      .child(body)
      .when(Boolean(m.quote) && !editing, (el) => el.child(div().pl(8).truncate().border_l(2).border_color(t.border).text_size(11.5).italic().text_color(t.dim).child(`“${m.quote}”`)))
      .child(h_flex().pt(2).gap(2).children(actions));
  }

  // What MEMORIES.md says now: one row per line, a merged line removes all its memories at once.
  kept(t, p) {
    const sections = (p.kept ?? [])
      .map((sec) => ({ ...sec, items: sec.items.filter((it) => !this.hidden.has(it.ids.join(","))) }))
      .filter((sec) => sec.items.length);
    const count = sections.reduce((n, sec) => n + sec.items.length, 0);
    if (!count) return null;
    const open = this.keptOpen;
    const row = (it) => {
      const key = it.ids.join(",");
      const editing = this.editing?.id === key ? this.editing : null;
      if (editing)
        return v_flex()
          .id(`kept-${key}`)
          .px(6)
          .py(4)
          .gap(6)
          .child(
            div()
              .id(`kept-edit-${key}`)
              .rounded(6)
              .border(1)
              .border_color(t.accent)
              .bg(t.background)
              .px(8)
              .py(5)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Textarea.new(editing.state).w_full().text_size(12).text_color(t.foreground)),
          )
          .child(
            h_flex()
              .gap(2)
              .child(this.button(t, `kept-save-${key}`, "Save", "check", "primary", (cx) => this.act("edit", p.root, { id: key, text: it.text }, cx, editing.state.value())))
              .child(
                this.button(t, `kept-cancel-${key}`, "Cancel", null, "plain", (cx) => {
                  this.editing = null;
                  cx.notify();
                }),
              ),
          );
      return h_flex()
        .id(`kept-${key}`)
        .h(H.keptRow - 2)
        .overflow_hidden()
        .px(6)
        .py(4)
        .gap(8)
        .items_start()
        .tooltip(`${it.label ? `${it.label}: ` : ""}${it.text}\n\n${tip("Edit", "E")} · ${tip("Remove", "D")} · right-click for more`)
        .rounded(6)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("right", () => this.keptMenu(p, it))
        .on_hover((on, cx) => {
          if (on) this.hoverKept = key;
          else if (this.hoverKept === key) this.hoverKept = null;
          cx.notify();
        })
        .child(svg(ICON("check")).size(11).flex_none().mt(3).text_color(t.done))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .text_size(12)
            .text_color(t.muted)
            .when(Boolean(it.label), (el) => el.child(div().font_medium().text_color(t.foreground).child(it.label)))
            .child(it.text),
        )
        .child(
          div()
            .id(`kept-rm-${key}`)
            .flex_none()
            .p(2)
            .rounded(4)
            .cursor_pointer()
            .text_color(this.hoverKept === key ? t.dim : t.chrome)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(it.ids.length > 1 ? `Remove from MEMORIES.md (${it.ids.length} merged memories)` : "Remove from MEMORIES.md")
            .on_click((_e, cx) => this.act("remove", p.root, { id: key, text: it.label ? `${it.label}: ${it.text}` : it.text }, cx))
            .child(svg(ICON("x")).size(11)),
        );
    };
    const header = h_flex()
      .id(`kept-${p.root}`)
      .h(26)
      .px(4)
      .gap(6)
      .items_center()
      .cursor_pointer()
      .text_size(11)
      .text_color(t.dim)
      .hover((s) => s.text_color(t.foreground))
      .tooltip(tip(open ? "Hide kept memories" : "Show kept memories", "Enter"))
      .on_click((_e, cx) => {
        this.keptOpen = !open;
        cx.notify();
      })
      .child(svg(ICON(open ? "chevron-down" : "chevron")).size(11))
      .child(div().child("Kept in MEMORIES.md"))
      .child(div().text_color(t.muted).font_medium().child(String(count)));
    const rows = !open
      ? []
      : sections.flatMap((sec) => [
          ...(sections.length > 1 ? [{ kind: "keptHeading", key: `kh-${p.root}-${sec.heading}`, h: H.keptHeading, el: div().px(6).pt(6).text_size(10.5).font_medium().text_color(t.dim).child(sec.heading) }] : []),
          ...sec.items.map((it) => {
            const key = it.ids.join(",");
            return { kind: "kept", key: `kept:${key}`, select: true, p, it, h: this.editing?.id === key ? H.keptEdit : H.keptRow, el: row(it) };
          }),
        ]);
    return { header, rows };
  }

  render(cx) {
    const t = theme();
    const sp = focused()?.space ?? this.space;
    const projects = sp ? this.cache[sp] : null;
    const error = sp ? this.errors[sp] : null;
    const pending = (projects ?? []).flatMap((p) => p.pending.filter((m) => !this.hidden.has(m.id)).map((m) => ({ p, m })));
    const many = (projects ?? []).length > 1;

    let empty = null;
    if (!projects) empty = this.loading ? "Reading…" : "";
    else if (!projects.length) empty = "No project here yet. Suggestions come from Pi sessions inside a git repository.";
    else if (!pending.length) empty = "Nothing to review. Rules you state in your prompts show up here to keep or dismiss.";

    const header = h_flex()
      .id("memories-header")
      .px(14)
      .h(36)
      .flex_none()
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tip(this.collapsed ? "Expand Memories" : "Collapse Memories", "−"))
      .on_click(() => this.setCollapsed(!this.collapsed))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(this.collapsed ? "▸" : "▾"))
      .child(div().flex_none().text_size(11.5).font_medium().text_color(this.handle.is_focused() ? t.accent : t.dim).child("Memories"))
      .when(this.collapsed, (el) => el.child(div().flex_none().text_size(12).text_color(t.muted).child(`· ${pending.length} to review`)))
      .when(pending.length > 0 && !this.collapsed, (el) =>
        el.child(div().flex_none().px(6).h(16).rounded(8).bg(t.accent).text_color(t.accent_foreground ?? t.background).text_size(10.5).font_medium().flex().items_center().child(String(pending.length))),
      )
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(projects?.length === 1 && !this.collapsed ? projects[0].name : ""));

    const undo = this.undo
      ? h_flex()
          .mx(10)
          .mb(6)
          .px(10)
          .h(28)
          .gap(8)
          .flex_none()
          .items_center()
          .rounded(8)
          .bg(t.raised)
          .text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${this.undo.action === "remove" ? "Removed" : "Dismissed"}: ${this.undo.text}`))
          .child(
            div()
              .id("mem-undo")
              .flex_none()
              .cursor_pointer()
              .font_medium()
              .text_color(t.accent)
              .on_click((_e, cx) => {
                const u = this.undo;
                this.undo = null;
                this.act(u.action === "remove" ? "accept" : "restore", u.root, { id: u.id, text: u.text }, cx);
                this.hidden.delete(u.id);
              })
              .child("Undo"),
          )
          .child(
            div()
              .id("mem-undo-x")
              .flex_none()
              .cursor_pointer()
              .text_color(t.dim)
              .on_click((_e, cx) => {
                this.undo = null;
                cx.notify();
              })
              .child(svg(ICON("x")).size(11)),
          )
      : null;

    // One flat list for the virtual list and for ↑/↓: project names, suggestions, kept lines.
    const items = [];
    for (const p of projects ?? []) {
      if (many) items.push({ kind: "project", key: `p-${p.root}`, h: H.project, el: div().px(4).pt(4).text_size(11).font_medium().text_color(t.dim).child(p.name) });
      for (const { m } of pending.filter((x) => x.p === p)) items.push({ kind: "suggestion", key: `s:${m.id}`, select: true, p, m, h: this.editing?.id === m.id ? H.editing : m.quote ? H.quoted : H.suggestion, el: this.suggestion(t, p, m) });
      const k = this.kept(t, p);
      if (k) {
        items.push({ kind: "keptHeader", key: `kh:${p.root}`, select: true, p, h: H.keptHeader, el: k.header });
        items.push(...k.rows);
      }
    }
    this.items = items;
    if (!items.some((x) => x.select && x.key === this.sel)) this.sel = items.find((x) => x.select)?.key ?? null;
    const hasKeys = this.handle.is_focused();
    const ring = (x) => (x.kind !== "suggestion" && hasKeys && x.key === this.sel ? (el) => el.rounded(6).border(1).border_color(t.accent) : (el) => el);

    const shell = v_flex()
      .id("root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.command(e.keystroke, cx)) cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .when(hasKeys, (el) => el.border_t(2).border_color(t.accent))
      .child(header);
    if (this.collapsed) return shell;
    return shell
      .when(Boolean(undo), (el) => el.child(undo))
      .when(Boolean(empty), (el) => el.child(div().px(16).pt(4).pb(8).text_size(12).text_color(t.dim).child(empty)))
      .when(items.length > 0, (el) => el.child(windowedList(this, t, "mem-list", items.map((x) => x.h), (i) => div().px(10).pb(items[i].kind === "suggestion" ? 8 : 0).child(ring(items[i])(div().child(items[i].el))), 130, NAME)))
      .when(!items.length, (el) => el.child(div().flex_1()))
      .child(legend(t, [["↑↓", "Select"], ["Enter", "Keep"], ["E", "Edit"], ["D", "Dismiss"], ["Tab", "Next"], ["−", "Collapse"], ["Esc", "Back"]]))
      .when(Boolean(this.notice), (el) => el.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(this.notice)))
      .when(Boolean(error), (el) => el.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.blocked).child(error)));
  }
}
