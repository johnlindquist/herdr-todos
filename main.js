// Todos: the task lists of the Pi sessions in the shown space, kept up to date in the background.
// The work happens in todos.mjs (Node): it maps terminals to Pi journals, reads `todo` boards and
// asks a small model to summarize the rest. This view decides when to refresh and draws the result.
// Every space's last result is cached on disk, so switching spaces shows it at once.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, focused, panes, exec, home, appHome, run, theme, readTextFile, nextCommand, shared, setShared } from "herdr";

const NAME = "todos";
const ICON = (n) => `mods/${NAME}/icons/${n}.svg`;
const helper = () => `${appHome()}/mods/${NAME}/todos.mjs`;
const stateDir = () => {
  const app = appHome();
  const key = app === `${home()}/.config/herdr-app` ? "default" : app.replace(/[^A-Za-z0-9]/g, "_");
  return `${home()}/.cache/herdr-todos/${key}`;
};
// Spaces on another machine ("m1/sp…") are read there: the helper is piped through herdr-core to
// that machine's Node, so its Pi journals, git roots, model logins and memories.md stay on it and
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
  if (machine && /cannot start node|node: (command )?not found|exec: node/i.test(text)) return `${machine} needs Node and Pi for Todos`;
  try {
    const e = JSON.parse(text.split("\n").pop());
    return typeof e.message === "string" ? e.message : e.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || `exit ${r.code}`;
  }
}
// The helper on a machine knows its terminals as "t7"; this window knows them as "m1/t7".
function fromMachine(doc, machine) {
  if (!machine || !doc) return doc;
  const q = (a) => `${machine}/${a}`;
  return {
    ...doc,
    sessions: (doc.sessions ?? []).map((x) => ({ ...x, terminal: q(x.terminal) })),
    prefs: doc.prefs && {
      order: (doc.prefs.order ?? []).map(q),
      priority: Object.fromEntries(Object.entries(doc.prefs.priority ?? {}).map(([k, v]) => [q(k), v])),
    },
  };
}
const bare = (addr, machine) => (machine && addr.startsWith(`${machine}/`) ? addr.slice(machine.length + 1) : addr);
const stateFile = (space) => `${stateDir()}/spaces/${space.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

const PERIODIC_MS = 60_000; // the shown space, while a session in it works
const QUIET_MS = 10 * 60_000; // the shown space, otherwise
const RANK = { blocked: 0, error: 0, working: 1, done: 2, idle: 3 };
const TASK_ORDER = { blocked: 0, in_progress: 1, todo: 2, done: 3 };
const LEVEL = { high: 0, normal: 1, low: 2 };

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Pi titles its terminal "π - <session name> - <folder>".
const cleanTitle = (x) => (x ?? "").replace(/^π\s*-\s*/, "").replace(/\s+-\s+[^-]+$/, "").trim();

// Focuses a pane so it is actually seen. A zoomed tab keeps showing its zoomed pane when another
// pane gets focus, so: if the person is zoomed in now, or the pane's tab is zoomed on another
// pane, zoom the clicked pane instead.
function showPane(pane) {
  const all = panes();
  const target = all.find((p) => p.pane === pane);
  if (!target) return run("pane.focus", { pane });
  const zoomedNow = all.some((p) => p.focused && p.zoomed);
  const zoomedThere = all.find((p) => p.tab === target.tab && p.zoomed);
  const siblings = all.filter((p) => p.tab === target.tab).length;
  run("pane.focus", { pane });
  if (siblings > 1 && !target.zoomed && (zoomedNow || zoomedThere)) run("pane.zoom", { pane });
}

const statusClass = (s) => (s === "working" ? "working" : s === "blocked" || s === "error" ? "blocked" : "rest");

export default class Todos extends View {
  init(_props, cx) {
    this.cache = {}; // space id -> last helper document
    this.busy = new Set(); // spaces being refreshed
    this.again = new Set(); // spaces to refresh once more when the current run ends
    this.scheduled = new Set();
    this.waiting = []; // spaces queued behind the two running refreshes
    this.prefs = {}; // space id -> { order, priority } as the person set them
    this.editedAt = {}; // space id -> ms of the last edit here
    this.pressed = null; // the card being dragged
    this.over = null;
    this.hoverTask = null;
    this.errors = {}; // space id -> helper error text
    this.lastRun = {}; // space id -> ms of the last finished refresh
    this.seen = null; // pi agent address -> status class, from the last tick
    this.shownSpace = null;
    this.tick(cx);
    cx.timer.every(2000, (cx) => this.tick(cx));
    cx.timer.every(PERIODIC_MS, (cx) => {
      this.periodic(cx);
      cx.notify(); // the "3m" ages
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh" && this.shownSpace) this.refresh(this.shownSpace, cx, true);
      }
    });
  }

  // Watches the live agent list (no redraw unless something changed) and queues refreshes:
  // the shown space when it changes, any space whose Pi session changed state.
  tick(cx) {
    const sp = focused()?.space ?? null;
    if (sp && sp !== this.shownSpace) {
      this.shownSpace = sp;
      if (!this.cache[sp]) this.load(sp, cx);
      this.want(sp, cx, 0);
      cx.notify();
    }
    const now = new Map();
    for (const a of agents()) if (a.app === "pi") now.set(a.address, { cls: statusClass(a.status), space: a.space });
    if (this.seen) {
      for (const [addr, v] of now) {
        const before = this.seen.get(addr);
        // A new prompt is written a moment after the run starts; a finished reply right away.
        if (before === undefined) this.want(v.space, cx, 4000);
        else if (before.cls !== v.cls) this.want(v.space, cx, v.cls === "working" ? 6000 : 1500);
      }
      for (const [addr, v] of this.seen) if (!now.has(addr)) this.want(v.space, cx, 500);
    }
    this.seen = now;
    if (!this.warmed && now.size) {
      this.warmed = true;
      this.warm(cx);
    }
  }

  periodic(cx) {
    const sp = this.shownSpace;
    if (!sp) return;
    const working = agents().some((a) => a.space === sp && a.app === "pi" && a.status === "working");
    const since = Date.now() - (this.lastRun[sp] ?? 0);
    if (working || since > QUIET_MS) this.want(sp, cx, 0);
  }

  want(space, cx, delay) {
    if (!space || this.scheduled.has(space)) return;
    this.scheduled.add(space);
    cx.timer.after(Math.max(16, delay), (cx) => {
      this.scheduled.delete(space);
      this.refresh(space, cx, false);
    });
  }

  // Fills the cache for every space with a Pi session, one after another, so a first visit
  // to a space already has its lists.
  warm(cx) {
    const ids = [...new Set(agents().filter((a) => a.app === "pi").map((a) => a.space))];
    ids.filter((id) => id !== this.shownSpace).forEach((id, i) => this.want(id, cx, 3000 + i * 2500));
  }

  load(space, cx) {
    const { machine, id } = where(space);
    cx.spawn(async (cx) => {
      try {
        let doc = null;
        if (!machine) {
          const text = await readTextFile(stateFile(space));
          doc = text ? JSON.parse(text) : null;
        } else {
          const r = await callHelper(machine, ["show", "--space", id], 60_000);
          if (r.code === 0) doc = fromMachine(JSON.parse(r.stdout), machine);
        }
        if (doc && doc.state !== "missing" && !this.cache[space]) {
          this.cache[space] = doc;
          cx.notify();
        }
      } catch {}
    });
  }

  refresh(space, cx, force) {
    if (this.busy.has(space)) {
      this.again.add(space);
      return;
    }
    if (this.busy.size >= 2 && !force) {
      // At most two at once; the rest wait their turn (the shown space first).
      if (!this.waiting.includes(space)) space === this.shownSpace ? this.waiting.unshift(space) : this.waiting.push(space);
      return;
    }
    this.busy.add(space);
    if (space === this.shownSpace) cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { machine, id } = where(space);
        const argv = ["refresh", "--space", id];
        if (force) argv.push("--force");
        const r = await callHelper(machine, argv, 300_000);
        if (r.code === 0) {
          const doc = fromMachine(JSON.parse(r.stdout), machine);
          if (!doc.busy) {
            this.cache[space] = doc;
            // Adopt saved choices (an agent may have set them) unless edited here since this read began.
            if (!(this.editedAt[space] > (doc.updated_at ?? 0))) delete this.prefs[space];
          }
          delete this.errors[space];
        } else this.errors[space] = helperError(r, machine);
      } catch (e) {
        this.errors[space] = String(e?.message ?? e);
      }
      this.lastRun[space] = Date.now();
      // Memories (the panel below) reads suggestions this refresh may have added.
      setShared("todos.updated", { ...(shared("todos.updated") ?? {}), [space]: Date.now() });
      this.busy.delete(space);
      if (this.again.delete(space)) this.refresh(space, cx, false);
      const next = this.waiting.shift();
      if (next) this.refresh(next, cx, false);
      cx.notify();
    });
  }

  // ---------- the person's order and priorities ----------

  prefsFor(space) {
    if (!this.prefs[space]) {
      const p = this.cache[space]?.prefs;
      if (!p) return { order: [], priority: {} };
      this.prefs[space] = { order: [...(p.order ?? [])], priority: { ...(p.priority ?? {}) } };
    }
    return this.prefs[space];
  }

  // Saves through the helper, so its CLI, cache and this view agree. Shown at once; saved after.
  save(space, argv, cx) {
    this.editedAt[space] = Date.now();
    cx.spawn(async (cx) => {
      try {
        const { machine, id } = where(space);
        const r = await callHelper(machine, [...argv, "--space", id], 60_000);
        if (r.code !== 0) this.errors[space] = `Couldn't save: ${helperError(r, machine)}`;
        else delete this.errors[space];
      } catch (e) {
        this.errors[space] = `Couldn't save: ${String(e?.message ?? e)}`;
      }
      cx.notify();
    });
  }

  move(from, to, cx) {
    const sp = this.shownSpace;
    const list = [...(this.shownOrder ?? [])];
    const fromAt = list.indexOf(from);
    const toAt = list.indexOf(to);
    if (!sp || fromAt < 0 || toAt < 0) return;
    list.splice(fromAt, 1);
    list.splice(fromAt < toAt ? list.indexOf(to) + 1 : list.indexOf(to), 0, from);
    this.prefs[sp] = { ...this.prefsFor(sp), order: list };
    this.save(sp, ["order", "--terminals", list.map((a) => bare(a, where(sp).machine)).join(",")], cx);
  }

  setPriority(terminal, key, level, cx) {
    const sp = this.shownSpace;
    if (!sp || !terminal || !key) return;
    const prefs = this.prefsFor(sp);
    const k = `${terminal}|${key}`;
    const priority = { ...prefs.priority };
    if (level === "normal") delete priority[k];
    else priority[k] = level;
    this.prefs[sp] = { ...prefs, priority };
    this.save(sp, ["priority", "--terminal", bare(terminal, where(sp).machine), "--task", key, "--level", level], cx);
    cx.notify();
  }

  // ---------- drawing ----------

  statusColor(t, s) {
    return s === "working" ? t.working : s === "blocked" || s === "error" ? t.blocked : s === "done" ? t.done : t.idle;
  }

  dot(t, status) {
    const d = div().w(8).h(8).rounded(4).flex_none().bg(this.statusColor(t, status));
    return status === "working" ? d.loop("opacity", { from: 0.3, to: 1, period: 1400 }) : d;
  }

  taskRow(t, task, i, key, terminal) {
    const s = task.status;
    const level = task.priority ?? "normal";
    const rowId = `${key}-t${i}`;
    const icon =
      s === "in_progress"
        ? svg(ICON("spinner")).size(13).flex_none().text_color(t.working).spin(1100)
        : s === "done"
          ? svg(ICON("done")).size(13).flex_none().text_color(t.done)
          : s === "blocked"
            ? svg(ICON("blocked")).size(13).flex_none().text_color(t.blocked)
            : svg(ICON("todo")).size(13).flex_none().text_color(t.dim);
    const low = level === "low" && s !== "done";
    const text = div()
      .flex_1()
      .min_w(0)
      .text_size(12.5)
      .text_color(s === "done" || low ? t.dim : s === "todo" ? t.muted : s === "blocked" ? t.blocked : t.foreground)
      .when(level === "high" && s !== "done", (el) => el.font_medium().text_color(s === "blocked" ? t.blocked : t.foreground))
      .when(s === "done", (el) => el.truncate())
      .child(task.text);
    // The flag: shown when set, or on hover. Click: normal -> high -> low -> normal.
    const showFlag = s !== "done" && task.key && (level !== "normal" || this.hoverTask === rowId);
    const flag = div()
      .id(`${rowId}-flag`)
      .flex_none()
      .mt(1)
      .p(2)
      .rounded(4)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(level === "high" ? "High priority (click: low)" : level === "low" ? "Low priority (click: normal)" : "Mark high priority")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.setPriority(terminal, task.key, level === "normal" ? "high" : level === "high" ? "low" : "normal", cx);
      })
      .child(
        level === "low"
          ? svg(ICON("low")).size(12).text_color(t.dim)
          : svg(ICON(level === "high" ? "flag-on" : "flag")).size(12).text_color(level === "high" ? t.ansi3 ?? t.working : t.dim),
      );
    return h_flex()
      .id(rowId)
      .gap(8)
      .items_start()
      .on_hover((on, cx) => {
        if (on) this.hoverTask = rowId;
        else if (this.hoverTask === rowId) this.hoverTask = null;
        cx.notify();
      })
      .child(div().pt(2).flex_none().child(icon))
      .child(text)
      .child(showFlag ? flag : div().w(16).flex_none());
  }

  card(t, a, s, busy, showTab, dropBelow) {
    const addr = a?.address ?? s?.terminal;
    const status = a?.status ?? s?.status ?? "idle";
    const title = s?.title || s?.name || cleanTitle(a?.title) || "Pi session";
    const sorted = [...(s?.tasks ?? [])].sort(
      (x, y) => (TASK_ORDER[x.status] ?? 9) - (TASK_ORDER[y.status] ?? 9) || (LEVEL[x.priority] ?? 1) - (LEVEL[y.priority] ?? 1),
    );
    // Glanceable: everything active or high, the next few, the latest couple done.
    const pick = (st, n) => sorted.filter((x) => x.status === st).filter((x, i) => i < n || x.priority === "high");
    const tasks = [...pick("blocked", 9), ...pick("in_progress", 9), ...pick("todo", 3), ...pick("done", 2)];
    const hidden = sorted.length - tasks.length;
    const key = `c-${a?.address ?? s?.terminal}`;
    const needsYou = status === "blocked";
    // Only when it tells sessions apart: a named tab, or sessions spread over several tabs.
    const tabLabel = !a ? null : a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : showTab ? `Tab ${a.tab_index}` : null;
    const sourceIcon =
      s?.source === "board"
        ? svg(ICON("board")).size(11).flex_none().text_color(t.dim)
        : s?.source === "haiku"
          ? svg(ICON("sparkle")).size(11).flex_none().text_color(t.dim)
          : null;
    const placeholder = !s
      ? busy
        ? "Reading this session…"
        : "Not read yet"
      : !tasks.length && !s.now
        ? s.error
          ? null
          : "No tasks yet"
        : null;

    return v_flex()
      .id(key)
      .flex_none()
      .p(10)
      .gap(7)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(needsYou ? t.blocked : a?.focused ? t.input : t.border)
      .relative()
      .cursor_pointer()
      .hover((el) => el.border_color(t.input))
      .when(this.pressed === addr && this.over && this.over !== addr, (el) => el.opacity(0.45))
      .when(Boolean(this.pressed) && this.over === addr && this.pressed !== addr, (el) =>
        el.child(div().absolute().left(8).right(8).h(3).rounded(2).bg(t.accent).when(dropBelow, (l) => l.bottom(-7)).when(!dropBelow, (l) => l.top(-7))),
      )
      // Press and release on the same card: go to it. Release on another card: move it there.
      .on_mouse_down("left", () => {
        this.pressed = addr;
        this.over = addr;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed && this.over !== addr) {
          this.over = addr;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from && from !== addr) this.move(from, addr, cx);
        else if (from === addr) {
          if (a?.pane) showPane(a.pane);
          else if (s?.terminal) run("agent.focus", { terminal: s.terminal });
        }
        cx.notify();
      })
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(this.dot(t, status))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(t.foreground).child(title))
          .when(needsYou, (el) =>
            el.child(div().flex_none().px(6).py(1).rounded(6).bg(t.blocked).text_color(t.background).text_size(10.5).font_medium().child("Needs you")),
          )
          .when(Boolean(sourceIcon), (el) => el.child(div().id(`${key}-src`).tooltip(s.source === "board" ? "From this session's todo board" : "Summarized by Haiku").child(sourceIcon)))
          .when(Boolean(s?.summarized_at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(s.summarized_at)))),
      )
      .when(Boolean(tabLabel), (el) => el.child(div().mt(-4).pl(16).truncate().text_size(11).text_color(t.dim).child(tabLabel)))
      .when(Boolean(s?.now), (el) => el.child(div().pl(16).text_size(12).text_color(t.muted).child(s.now)))
      .when(tasks.length > 0, (el) => el.child(v_flex().pl(2).pt(2).gap(5).children(tasks.map((task, i) => this.taskRow(t, task, i, key, addr)))))
      .when(hidden > 0, (el) => el.child(div().pl(23).text_size(11).text_color(t.dim).child(`+${hidden} more`)))
      .when(Boolean(placeholder), (el) =>
        el.child(
          h_flex()
            .pl(16)
            .gap(6)
            .items_center()
            .text_size(12)
            .text_color(t.dim)
            .when(!s && busy, (el) => el.child(svg(ICON("spinner")).size(11).text_color(t.dim).spin(1100)))
            .child(placeholder),
        ),
      )
      .when(Boolean(s?.error), (el) => el.child(div().pl(16).text_size(11).text_color(t.dim).child(`Not updated: ${s.error}`)));
  }

  chip(t, color, n, label) {
    return h_flex()
      .gap(5)
      .items_center()
      .px(7)
      .h(20)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .child(div().w(6).h(6).rounded(3).bg(color))
      .child(div().text_size(11).text_color(t.foreground).font_medium().child(String(n)))
      .child(div().text_size(11).text_color(t.dim).child(label));
  }

  render(cx) {
    const t = theme();
    const sp = focused()?.space ?? this.shownSpace;
    const space = spaces().find((s) => s.id === sp);
    const doc = sp ? this.cache[sp] : null;
    const busy = sp ? this.busy.has(sp) : false;

    // A terminal keeps its last report after Pi exits, so once the helper has read the space its
    // list decides which are Pi sessions; agents it hasn't seen yet show while a read is running.
    const live = agents().filter((a) => a.space === sp && a.app === "pi");
    const bySession = new Map((doc?.sessions ?? []).map((s) => [s.terminal, s]));
    const rows = live
      .map((a) => ({ a, s: bySession.get(a.address) }))
      .filter(({ s }) => s || !doc || busy);
    // The person's order first (dragged cards), then the rest by urgency.
    const prefs = sp ? this.prefsFor(sp) : { order: [], priority: {} };
    const ranked = new Map(prefs.order.map((addr, i) => [addr, i]));
    const rankOf = (r) => (ranked.has(r.a.address) ? ranked.get(r.a.address) : Infinity);
    rows.sort((x, y) => rankOf(x) - rankOf(y) || (RANK[x.a.status] ?? 9) - (RANK[y.a.status] ?? 9) || x.a.tab_index - y.a.tab_index);
    for (const r of rows) {
      if (!r.s?.tasks) continue;
      r.s = { ...r.s, tasks: r.s.tasks.map((task) => ({ ...task, priority: prefs.priority[`${r.a.address}|${task.key}`] ?? "normal" })) };
    }
    this.shownOrder = rows.map((r) => r.a.address);
    const pressedAt = this.shownOrder.indexOf(this.pressed);

    const all = rows.flatMap((r) => r.s?.tasks ?? []);
    const count = (st) => all.filter((x) => x.status === st).length;
    const needsYou = rows.filter((r) => r.a.status === "blocked").length + count("blocked");
    const chips = [
      needsYou ? this.chip(t, t.blocked, needsYou, "needs you") : null,
      count("in_progress") ? this.chip(t, t.working, count("in_progress"), "doing") : null,
      count("todo") ? this.chip(t, t.dim, count("todo"), "next") : null,
      count("done") ? this.chip(t, t.done, count("done"), "done") : null,
    ].filter(Boolean);

    const error = sp ? this.errors[sp] : null;
    let empty = null;
    if (!sp) empty = "No space shown";
    else if (!rows.length) empty = busy && !doc ? "Reading sessions…" : "No Pi sessions in this space";

    const header = h_flex()
      .px(14)
      .h(44)
      .pt(10)
      .flex_none()
      .gap(8)
      .items_center()
      .child(div().flex_none().text_size(11.5).font_medium().text_color(t.dim).child("Todos"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(space?.name ?? ""))
      .child(
        div()
          .id("todos-refresh")
          .flex_none()
          .p(3)
          .rounded(5)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(busy ? "Updating…" : "Update now")
          .on_click((_e, cx) => sp && this.refresh(sp, cx, true))
          .child(busy ? svg(ICON("spinner")).size(13).spin(900) : svg(ICON("refresh")).size(13)),
      );

    const footerText = busy ? "Updating…" : doc?.updated_at ? `Updated ${ago(doc.updated_at) === "now" ? "just now" : `${ago(doc.updated_at)} ago`}` : "";

    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .text_size(13)
      .child(header)
      .when(chips.length > 0 && !empty, (el) => el.child(h_flex().px(12).pb(8).pt(2).gap(6).flex_wrap().flex_none().children(chips)))
      .when(Boolean(empty), (el) =>
        el.child(
          v_flex()
            .px(16)
            .pt(16)
            .gap(6)
            .child(div().text_size(12.5).text_color(t.muted).child(empty))
            .when(!busy && Boolean(sp) && !rows.length, (el) =>
              el.child(div().text_size(12).text_color(t.dim).child("Start Pi in a tab here. Its tasks show up after the first reply.")),
            ),
        ),
      )
      .when(!empty, (el) =>
        el.child(
          v_flex()
            .id("todos-list")
            .flex_1()
            .min_h(0)
            .px(10)
            .pb(10)
            .gap(8)
            .overflow_y_scrollbar()
            .on_mouse_up("left", (_e, cx) => {
              this.pressed = null;
              this.over = null;
              cx.notify();
            })
            .children(rows.map(({ a, s }, i) => this.card(t, a, s, busy, new Set(rows.map((r) => r.a.tab)).size > 1, pressedAt >= 0 && pressedAt < i))),
        ),
      )
      .when(Boolean(empty), (el) => el.child(div().flex_1()))
      .child(
        v_flex()
          .flex_none()
          .px(14)
          .py(7)
          .gap(2)
          .border_t(1)
          .border_color(t.border)
          .when(Boolean(error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`Update failed: ${error}`)))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .text_size(11)
              .text_color(t.dim)
              .child(div().flex_1().truncate().child(footerText))
              .child(div().flex_none().child(doc?.model ? String(doc.model).split("/").pop().replace(/^claude-/, "") : "")),
          ),
      );
  }
}
