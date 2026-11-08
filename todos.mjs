#!/usr/bin/env node
// Todos for a Herdr space: finds the Pi sessions running in that space, reads their journals and
// keeps a short task list per session. Task boards written by Pi's `todo` tool are read as-is;
// other sessions are summarized by a small model (Haiku by default) when their journal changes.
//
//   node todos.mjs refresh --space <id> [--state <dir>] [--model <provider/id>] [--force]
//   node todos.mjs show    --space <id> [--state <dir>]
//   node todos.mjs describe
//
// stdout is one JSON document. Errors print JSON to stderr and exit 1.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const WORKING_RESUMMARY_MS = 120_000; // a session still working is summarized at most this often
const RECENT_FILE_DAYS = 21;
const MAX_FILES_PER_DIR = 80;
const TAIL_BYTES = 768 * 1024;
const CONVERSATION_BUDGET = 14_000;
const MAX_PARALLEL = 4;

// ---------- args ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stateDir = path.resolve(expandHome(typeof args.state === "string" ? args.state : "~/.cache/herdr-todos"));
const model = typeof args.model === "string" ? args.model : process.env.HERDR_TODOS_MODEL || DEFAULT_MODEL;
const piAgentDir = expandHome(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ error: code, message, ...extra }) + "\n");
  process.exit(1);
}

// ---------- small io helpers ----------

function run(cmd, argv, { input, timeout = 30_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[timeout after ${timeout}ms]`;
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function hcJson(argv) {
  const r = await run("hc", [...argv, "--json"], { timeout: 15_000 });
  if (r.code !== 0) throw new Error(`hc ${argv.join(" ")} failed: ${r.stderr.trim() || r.code}`);
  return JSON.parse(r.stdout);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 1));
  await fs.rename(tmp, file);
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const spaceFile = (space) => path.join(stateDir, "spaces", `${space.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const indexFile = () => path.join(stateDir, "index.json");
const prefsFile = (space) => path.join(stateDir, "prefs", `${space.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const LEVELS = ["high", "normal", "low"];

// The person's choices for a space: session order (terminal addresses, first = most important)
// and task priorities keyed "<terminal>|<task key>".
async function readPrefs(space) {
  const p = await readJson(prefsFile(space), {});
  return { order: Array.isArray(p.order) ? p.order.filter((x) => typeof x === "string") : [], priority: p.priority && typeof p.priority === "object" ? p.priority : {} };
}

// Stable identity for a task: a board task's id, else its words.
const taskKey = (t) => (t.id != null ? `#${t.id}` : t.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());

function applyPrefs(doc, prefs) {
  const rank = new Map(prefs.order.map((a, i) => [a, i]));
  for (const s of doc.sessions) {
    s.tasks = (s.tasks ?? []).map((t) => {
      const key = taskKey(t);
      const level = prefs.priority[`${s.terminal}|${key}`];
      return { ...t, key, priority: LEVELS.includes(level) ? level : "normal" };
    });
    s.rank = rank.has(s.terminal) ? rank.get(s.terminal) : null;
  }
  doc.prefs = prefs;
  return doc;
}

// ---------- Pi session journals ----------

// Pi keeps a folder per working directory: /Users/me/dev/app -> --Users-me-dev-app--
function sessionDirFor(cwd) {
  const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(piAgentDir, "sessions", slug);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// Reads only what was appended since the last scan: session names, the first request and the
// latest task-board snapshot. Journals are append-only; a shrunk file is rescanned.
async function scanFile(file, stat, prev) {
  let entry = prev && prev.size <= stat.size && prev.ino === stat.ino ? { ...prev } : { offset: 0, name: null, first: null, board: null, boardAt: null };
  entry.size = stat.size;
  entry.mtime = stat.mtimeMs;
  entry.ino = stat.ino;
  if (entry.offset >= stat.size) return entry;
  const fh = await fs.open(file, "r");
  try {
    const length = stat.size - entry.offset;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, entry.offset);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < 0) return entry;
    const text = buf.subarray(0, lastNl).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (line.includes('"session_info"')) {
        try {
          const e = JSON.parse(line);
          if (e.type === "session_info") entry.name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : null;
        } catch {}
      } else if (line.includes('"herdr-pi-todos/v1"')) {
        try {
          const e = JSON.parse(line);
          if (e.type === "custom" && e.customType === "herdr-pi-todos/v1" && Array.isArray(e.data?.tasks)) {
            entry.board = e.data.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm || null, priority: t.priority }));
            entry.boardAt = e.timestamp || null;
          }
        } catch {}
      } else if (!entry.first && line.includes('"role":"user"')) {
        try {
          const e = JSON.parse(line);
          if (e.type === "message" && e.message?.role === "user") entry.first = textOf(e.message.content).slice(0, 1500) || null;
        } catch {}
      }
    }
    entry.offset += lastNl + 1;
  } finally {
    await fh.close();
  }
  return entry;
}

async function listSessionFiles(dir, index) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - RECENT_FILE_DAYS * 86400_000;
  const stats = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = path.join(dir, n);
    try {
      const st = await fs.stat(file);
      if (st.mtimeMs >= cutoff) stats.push({ file, st });
    } catch {}
  }
  stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const { file, st } of stats.slice(0, MAX_FILES_PER_DIR)) {
    index.files[file] = await scanFile(file, st, index.files[file]);
    out.push({ file, ...index.files[file] });
  }
  return out;
}

// The active branch's recent conversation: the newest entry, then its parents.
async function recentConversation(file) {
  const st = await fs.stat(file);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const fh = await fs.open(file, "r");
  let text;
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  const byId = new Map();
  let leaf = null;
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.id) continue;
    byId.set(e.id, e);
    if (e.type === "message") leaf = e;
  }
  const out = [];
  let used = 0;
  let pendingTools = [];
  for (let e = leaf; e && used < CONVERSATION_BUDGET; e = e.parentId ? byId.get(e.parentId) : null) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user") {
      const t = textOf(m.content).trim();
      if (!t) continue;
      const s = t.length > 1800 ? t.slice(0, 1800) + " …" : t;
      out.push({ id: e.id, role: "user", at: e.timestamp, text: s });
      used += s.length;
    } else if (m.role === "assistant") {
      const t = textOf(m.content).trim();
      const tools = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "toolCall").map((p) => p.name) : [];
      if (t) {
        const s = t.length > 1400 ? t.slice(0, 700) + " … " + t.slice(-600) : t;
        out.push({ id: e.id, role: "assistant", at: e.timestamp, text: s, tools: [...new Set([...tools, ...pendingTools])].slice(0, 8) });
        used += s.length;
        pendingTools = [];
      } else if (tools.length) {
        pendingTools.push(...tools);
      }
    }
  }
  return out.reverse();
}

// ---------- terminal -> session ----------

const REST = new Set(["done", "idle"]);

async function piTerminalsIn(space) {
  const raw = await hcJson(["ls"]);
  const ls = Array.isArray(raw) ? raw : raw.terminals ?? [];
  const pis = ls.filter((t) => t.state === "live" && t.agent === "pi");
  const details = await pool(pis, 8, async (t) => {
    try {
      return await hcJson(["get", t.address]);
    } catch {
      return null;
    }
  });
  return details.filter((d) => {
    if (!d || d.labels?.["herdr.space"] !== space || d.parent) return false;
    const argv0 = path.basename(d.foreground?.argv?.[0] ?? "");
    return /^pit?$/.test(argv0) || d.status?.app === "pi";
  });
}

function statusWord(t) {
  const s = t.status?.state ?? t.status;
  return typeof s === "string" ? s : "idle";
}

async function mapTerminals(terms, index, previous) {
  const claimed = new Set();
  const result = new Map();
  const prevBy = new Map((previous?.sessions ?? []).map((s) => [s.terminal, s]));
  const dirs = new Map();
  const filesFor = async (cwd) => {
    const dir = sessionDirFor(cwd);
    if (!dirs.has(dir)) dirs.set(dir, await listSessionFiles(dir, index));
    return dirs.get(dir);
  };
  const exists = async (f) => !!(await fs.stat(f).catch(() => null));

  // 1. An explicit label wins: pi.session=<file>.
  for (const t of terms) {
    const f = t.labels?.["pi.session"];
    if (f && (await exists(f))) {
      result.set(t.address, { file: f, mapping: "label" });
      claimed.add(f);
      await filesFor(t.foreground?.cwd || t.cwd);
    }
  }
  // 2. Pi reports its session name while working or done; match it to the journal's name.
  for (const t of terms) {
    if (result.has(t.address)) continue;
    const cwd = t.foreground?.cwd || t.cwd;
    const files = await filesFor(cwd);
    const name = ["working", "done"].includes(statusWord(t)) ? t.status?.msg?.trim() : null;
    if (!name) continue;
    const prev = prevBy.get(t.address);
    const matches = files.filter((f) => f.name === name && !claimed.has(f.file));
    if (!matches.length) continue;
    const keep = prev && prev.pid === t.foreground?.pid && matches.find((m) => m.file === prev.file);
    const pick = keep ?? matches[0];
    result.set(t.address, { file: pick.file, mapping: matches.length === 1 || keep ? "name" : "name-newest" });
    claimed.add(pick.file);
  }
  // 3. The same Pi process as last time keeps its journal.
  for (const t of terms) {
    if (result.has(t.address)) continue;
    const prev = prevBy.get(t.address);
    if (prev?.file && prev.pid === t.foreground?.pid && !claimed.has(prev.file) && (await exists(prev.file))) {
      result.set(t.address, { file: prev.file, mapping: "cached" });
      claimed.add(prev.file);
    }
  }
  // 4. Otherwise the newest unclaimed journal in its folder, if it changed since the process started.
  for (const t of terms) {
    if (result.has(t.address)) continue;
    const files = await filesFor(t.foreground?.cwd || t.cwd);
    const startedMs = t.created_ms ?? 0;
    const pick = files.find((f) => !claimed.has(f.file) && f.mtime >= startedMs - 60_000);
    if (pick) {
      result.set(t.address, { file: pick.file, mapping: "newest" });
      claimed.add(pick.file);
    } else result.set(t.address, { file: null, mapping: "none" });
  }
  return result;
}

// ---------- summaries ----------

const SYSTEM = `You keep a glanceable task list for one coding-agent session that a person checks between other work.
Return JSON only, no markdown:
{"title": string, "now": string, "tasks": [{"text": string, "status": "in_progress" | "todo" | "done" | "blocked"}]}
- title: 2-5 words naming what this session is about.
- now: at most 80 characters. While working: what the agent is doing. Otherwise: the outcome, or what the person should do next. Plain words; never "Session complete" or "Done.".
- tasks: 1-6 items the person asked for or the agent committed to. Outcomes, not individual tool calls. At most 60 characters each, starting with a verb.
- Reuse the wording of previous tasks that still apply and update their status, so the list stays stable between updates. A previous task with a "priority" was ranked by the person: keep its text exactly, character for character, and keep it in the list until it is done.
- "done" only when the conversation shows the work finished. "blocked" when it waits on the person: a question, an approval, a decision, a missing login. "in_progress" for what is being worked on now. "todo" for agreed work not started.
- Keep at most 3 done tasks: the most recent ones. Order: blocked, in_progress, todo, done.
- If the agent's status is "working", the newest request is not finished yet.`;

function parseModelJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model reply had no JSON object");
  const v = JSON.parse(cleaned.slice(a, b + 1));
  const STATUSES = ["in_progress", "todo", "done", "blocked"];
  const tasks = Array.isArray(v.tasks) ? v.tasks : [];
  return {
    title: String(v.title ?? "").slice(0, 60).trim() || null,
    now: String(v.now ?? "").slice(0, 120).trim() || null,
    tasks: tasks
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .slice(0, 8)
      .map((t) => ({ text: t.text.trim().slice(0, 90), status: STATUSES.includes(t.status) ? t.status : "todo" })),
  };
}

async function summarize({ status, name, cwd, first, conversation, previous }) {
  const payload = {
    agent_status: status,
    session_name: name,
    folder: cwd,
    first_request: first,
    previous: previous ? { title: previous.title, now: previous.now, tasks: (previous.tasks ?? []).map((t) => ({ text: t.text, status: t.status, ...(t.priority && t.priority !== "normal" ? { priority: t.priority } : {}) })) } : null,
    conversation,
  };
  const prompt = `Session data:\n${JSON.stringify(payload)}\n\nReturn the JSON task list now.`;
  const r = await run(
    "pi",
    ["-p", "--no-session", "-ne", "-nt", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--thinking", "off", "--model", model, "--system-prompt", SYSTEM],
    { input: prompt, timeout: 90_000, env: { ...process.env, PI_NO_TITLE: "1" } },
  );
  if (r.code !== 0) throw new Error((r.stderr.trim().split("\n").pop() || `pi exited ${r.code}`).slice(0, 200));
  return parseModelJson(r.stdout);
}

function boardTasks(board) {
  const MAP = { pending: "todo", in_progress: "in_progress", completed: "done" };
  const live = board.filter((t) => MAP[t.status]);
  const open = live.filter((t) => t.status !== "completed");
  const done = live.filter((t) => t.status === "completed").slice(-3);
  const order = { in_progress: 0, todo: 1, done: 2 };
  return [...open, ...done]
    .map((t) => ({ id: t.id, text: t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject, status: MAP[t.status] }))
    .sort((a, b) => order[a.status] - order[b.status]);
}

// ---------- memories ----------
// Candidate guidance from the person's own messages, kept per project (git root) until the person
// keeps or dismisses it. Kept ones live in <root>/memories.md, one line each, marked with an id;
// <root>/AGENTS.md links to that file.

const MEMORY_FILE = "memories.md";
const MEMORY_HEADER = `# Memories

Decisions and preferences from earlier work in this project. Follow them unless the current request says otherwise.
`;
const AGENTS_LINK = `Read [memories.md](memories.md) before you start: decisions and preferences from earlier work in this project. Follow them unless the current request says otherwise.`;
const MAX_NEW_FIRST_SIGHT = 2; // a session seen for the first time: only its latest prompts
const INJECTED = [
  /^The conversation history above was just compacted/,
  /^Provider retry activated/,
  /^Inspect subagent updates above/,
  /^\s*</,
  /^\[(?:subagent|hub|system|automated)/i,
];

const memStoreFile = (root) => path.join(stateDir, "memories", `${root.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const newId = () => Math.random().toString(36).slice(2, 10);
const marker = (id) => `<!-- memory:${id} -->`;

async function gitRoot(cwd, cache) {
  if (cache[cwd] !== undefined) return cache[cwd];
  const r = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  cache[cwd] = r.code === 0 ? r.stdout.trim() || null : null;
  return cache[cwd];
}

// Waits for the lock instead of skipping: memory writes must not be lost.
async function withWaitLock(name, fn) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = await withLock(name, async () => ({ value: await fn() }));
    if (r) return r.value;
    if (Date.now() > deadline) throw new Error("memories are busy; try again");
    await new Promise((res) => setTimeout(res, 150));
  }
}

async function readStore(root) {
  const s = await readJson(memStoreFile(root), null);
  return s && Array.isArray(s.items) ? s : { version: VERSION, root, items: [], processed: {} };
}

async function readMemoryFile(root) {
  return fs.readFile(path.join(root, MEMORY_FILE), "utf8").catch(() => null);
}

// The file is the authority for what is kept: a kept line someone deleted by hand is no longer kept.
async function reconcile(store) {
  const text = await readMemoryFile(store.root);
  for (const m of store.items) {
    if (m.status === "accepted" && !(text ?? "").includes(marker(m.id))) {
      m.status = "removed";
      m.updated_at = Date.now();
    }
  }
  return store;
}

async function writeMemoryLine(root, id, text) {
  const file = path.join(root, MEMORY_FILE);
  let body = (await readMemoryFile(root)) ?? MEMORY_HEADER;
  const line = `- ${text.replace(/\s+/g, " ").trim()} ${marker(id)}`;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.includes(marker(id)));
  if (at >= 0) lines[at] = line;
  else {
    while (lines.length && lines.at(-1) === "") lines.pop();
    if (!lines.at(-1)?.startsWith("- ")) lines.push("");
    lines.push(line);
  }
  body = lines.join("\n").replace(/\n*$/, "\n");
  await fs.writeFile(file, body);
  await ensureAgentsLink(root);
}

async function removeMemoryLine(root, id) {
  const body = await readMemoryFile(root);
  if (body == null) return;
  const kept = body.split("\n").filter((l) => !l.includes(marker(id)));
  await fs.writeFile(path.join(root, MEMORY_FILE), kept.join("\n").replace(/\n*$/, "\n"));
}

async function ensureAgentsLink(root) {
  const file = path.join(root, "AGENTS.md");
  const body = await fs.readFile(file, "utf8").catch(() => null);
  if (body != null && /\(?\.?\/?memories\.md\)?/i.test(body)) return;
  const next = body == null ? `${AGENTS_LINK}\n` : `${body.replace(/\n*$/, "\n")}\n${AGENTS_LINK}\n`;
  await fs.writeFile(file, next);
}

const MEMORY_SYSTEM = `You read what a person typed to a coding agent and pick out lasting guidance worth adding to the project's agent instructions, so future agents follow it without being told again.
Return JSON only, no markdown: {"memories": [{"text": string, "kind": "decision" | "preference" | "correction", "quote": string, "describes_current_request": boolean, "lasting": boolean}]}

A memory is a rule for future work: it would still be true and useful a month from now, in a different task in this project.
- decision: how this project does something. "the source of truth is the approved recording, not the script", "treat clicks as hints for the editing agent, never as destructive edits".
- preference: what the person likes in results or process. "support light and dark mode", "use the component layout system when showing components".
- correction: the person pushing back on something the agent did, so it doesn't happen again. Their reaction to the agent's previous reply counts.

Never a memory:
- A request, feature idea or task description, however detailed ("add a right-click menu to the sidebar", "build a todos panel"). Describing what to build now is not a rule for later.
- Questions, approvals and nudges ("go", "yes", "please continue", "ELI5"), status reports, thanks.
- Facts about the current bug or run.
- Anything in the known list, even reworded. Items marked rejected were turned down: never propose them or close variants.

text: one imperative sentence for a future agent, at most 160 characters. quote: the person's own words, verbatim, at most 120 characters. describes_current_request: true when the text restates what the person is asking the agent to build, change or do in this request (a feature, its behavior, its files). Those are dropped: a spec for the thing being built is not a rule for future work, even when it says "always" or describes how the feature should behave. lasting: false if it only matters for the current task; those are dropped too.
Most messages contain no memory. An empty list is the usual answer. At most 2.`;

async function proposeMemories({ messages, known }) {
  const prompt = `Known memories:\n${JSON.stringify(known)}\n\nNew messages (the agent's previous reply, then what the person typed):\n${JSON.stringify(messages)}\n\nReturn the JSON now.`;
  const r = await run(
    "pi",
    ["-p", "--no-session", "-ne", "-nt", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--thinking", "off", "--model", model, "--system-prompt", MEMORY_SYSTEM],
    { input: prompt, timeout: 90_000, env: { ...process.env, PI_NO_TITLE: "1" } },
  );
  if (r.code !== 0) throw new Error((r.stderr.trim().split("\n").pop() || `pi exited ${r.code}`).slice(0, 200));
  const cleaned = r.stdout.replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return [];
  const v = JSON.parse(cleaned.slice(a, b + 1));
  const KINDS = ["decision", "preference", "correction"];
  return (Array.isArray(v.memories) ? v.memories : [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim() && m.lasting !== false && m.describes_current_request !== true)
    .slice(0, 2)
    .map((m) => ({ text: m.text.trim().slice(0, 220), kind: KINDS.includes(m.kind) ? m.kind : "preference", quote: String(m.quote ?? "").slice(0, 160) }));
}

// New prompts in a session since it was last read for memories: each with the reply before it.
async function extractFrom(session, root) {
  const st = await fs.stat(session.file).catch(() => null);
  if (!st) return;
  const peek = await readStore(root);
  const seen = peek.processed[session.file];
  if (seen && seen.size === st.size) return;
  const conversation = await recentConversation(session.file);
  // Harness notes arrive as user messages too; they never carry the person's guidance.
  const users = conversation.filter((m) => m.role === "user" && !INJECTED.some((re) => re.test(m.text)));
  let fresh;
  if (!seen) fresh = users.slice(-MAX_NEW_FIRST_SIGHT);
  else {
    const at = users.findIndex((m) => m.id === seen.user);
    fresh = at >= 0 ? users.slice(at + 1) : users.slice(-MAX_NEW_FIRST_SIGHT);
  }
  const lastUser = users.at(-1)?.id ?? seen?.user ?? null;
  let proposed = [];
  if (fresh.length) {
    const messages = fresh.map((u) => {
      const i = conversation.indexOf(u);
      const before = conversation.slice(0, i).reverse().find((m) => m.role === "assistant");
      return { agent_before: before ? before.text.slice(-700) : null, person: u.text.slice(0, 1500), id: u.id };
    });
    const known = peek.items
      .filter((m) => m.status !== "removed" || m.updated_at > Date.now() - 30 * 86400_000)
      .slice(-80)
      .map((m) => (m.status === "dismissed" || m.status === "removed" ? `rejected: ${m.text}` : m.text));
    proposed = (await proposeMemories({ messages, known })).map((m) => ({ ...m, from: messages.at(-1).id }));
  }
  await withWaitLock(`mem-${root}`, async () => {
    const store = await readStore(root);
    const have = new Set(store.items.map((m) => norm(m.text)));
    for (const m of proposed) {
      if (have.has(norm(m.text))) continue;
      store.items.push({
        id: newId(),
        text: m.text,
        kind: m.kind,
        quote: m.quote,
        status: "pending",
        created_at: Date.now(),
        updated_at: Date.now(),
        source: { terminal: session.terminal, session: session.name, file: session.file, entry: m.from },
      });
      have.add(norm(m.text));
    }
    store.processed[session.file] = { size: st.size, user: lastUser };
    await writeJsonAtomic(memStoreFile(root), store);
  });
}

async function memoriesFor(roots) {
  const out = [];
  for (const root of roots) {
    const store = await withWaitLock(`mem-${root}`, async () => {
      const s = await reconcile(await readStore(root));
      await writeJsonAtomic(memStoreFile(root), s);
      return s;
    });
    const by = (st) => store.items.filter((m) => m.status === st);
    out.push({
      root,
      name: path.basename(root),
      file: path.join(root, MEMORY_FILE),
      pending: by("pending").sort((a, b) => b.created_at - a.created_at),
      accepted: by("accepted").sort((a, b) => a.updated_at - b.updated_at),
      dismissed: by("dismissed").length + by("removed").length,
    });
  }
  return out;
}

async function memoryAction(action, root, id, text) {
  return withWaitLock(`mem-${root}`, async () => {
    const store = await readStore(root);
    let m = store.items.find((x) => x.id === id);
    if (action === "add") {
      if (!text?.trim()) fail("INVALID", "--text is required");
      m = { id: newId(), text: text.trim(), kind: "decision", quote: "", status: "pending", created_at: Date.now(), updated_at: Date.now(), source: { manual: true } };
      store.items.push(m);
      action = "accept";
      text = null;
    }
    if (!m) fail("NOT_FOUND", `no memory ${id} for ${root}`);
    if (text != null && text.trim()) m.text = text.trim().replace(/\s+/g, " ");
    if (action === "accept") {
      await writeMemoryLine(root, m.id, m.text);
      m.status = "accepted";
    } else if (action === "dismiss") {
      m.status = "dismissed";
    } else if (action === "remove") {
      await removeMemoryLine(root, m.id);
      m.status = "removed";
    } else if (action === "restore") {
      m.status = "pending";
    } else if (action === "edit") {
      if (m.status === "accepted") await writeMemoryLine(root, m.id, m.text);
    } else fail("INVALID", `unknown memory action ${action}`);
    m.updated_at = Date.now();
    await writeJsonAtomic(memStoreFile(root), store);
    return m;
  });
}

// ---------- commands ----------

async function withLock(space, fn) {
  const lock = path.join(stateDir, "locks", `${space.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  try {
    const fh = await fs.open(lock, "wx");
    await fh.write(String(process.pid));
    await fh.close();
  } catch {
    const pid = Number(await fs.readFile(lock, "utf8").catch(() => "0"));
    const st = await fs.stat(lock).catch(() => null);
    let alive = false;
    try {
      if (pid) process.kill(pid, 0), (alive = true);
    } catch {}
    if (alive && st && Date.now() - st.mtimeMs < 5 * 60_000) return null;
    await fs.rm(lock, { force: true });
    return withLock(space, fn);
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

async function refresh(space, force) {
  const previous = await readJson(spaceFile(space), null);
  const result = await withLock(space, async () => {
    const index = await readJson(indexFile(), { version: VERSION, files: {} });
    const terms = await piTerminalsIn(space);
    const mapping = await mapTerminals(terms, index, previous);
    const prevBy = new Map((previous?.sessions ?? []).map((s) => [s.terminal, s]));
    const now = Date.now();

    const sessions = await pool(terms, MAX_PARALLEL, async (t) => {
      const { file, mapping: how } = mapping.get(t.address);
      const status = statusWord(t);
      const cwd = t.foreground?.cwd || t.cwd;
      const prev = prevBy.get(t.address);
      const base = {
        terminal: t.address,
        tab: t.labels?.["herdr.tab"] ?? null,
        pid: t.foreground?.pid ?? null,
        cwd,
        status,
        name: null,
        file,
        mapping: how,
        title: null,
        now: null,
        tasks: [],
        source: "none",
        summarized_at: null,
        fingerprint: null,
        error: null,
      };
      if (!file) return { ...base, now: "Waiting for this session's first message" };
      const info = index.files[file] ?? (await scanFile(file, await fs.stat(file), null));
      index.files[file] = info;
      base.name = info.name;
      const fingerprint = `${info.size}`;
      const same = prev && prev.file === file;

      if (info.board && info.board.length) {
        const at = Date.parse(info.boardAt ?? "") || now;
        return { ...base, title: info.name, tasks: boardTasks(info.board), source: "board", summarized_at: at, fingerprint };
      }
      const fresh = same && prev.fingerprint === fingerprint && prev.status === status && prev.source === "haiku" && !prev.error;
      const throttled = same && status === "working" && prev.status === "working" && prev.summarized_at && now - prev.summarized_at < WORKING_RESUMMARY_MS;
      if (!force && (fresh || throttled)) return { ...prev, status, mapping: how, name: info.name, pid: base.pid, tab: base.tab };

      try {
        const conversation = await recentConversation(file);
        if (!conversation.length) return { ...base, title: info.name, now: "No conversation yet", fingerprint };
        const s = await summarize({ status, name: info.name, cwd, first: info.first, conversation, previous: same ? prev : null });
        return { ...base, ...s, title: s.title || info.name, source: "haiku", summarized_at: now, fingerprint };
      } catch (e) {
        // Keep the last good list, say why it is stale.
        if (same && prev.tasks?.length) return { ...prev, status, mapping: how, error: String(e.message || e).slice(0, 200) };
        return { ...base, title: info.name, error: String(e.message || e).slice(0, 200) };
      }
    });

    // Project roots, then memory candidates from new prompts (after the task lists, so a slow
    // model call here never holds those back from the person).
    index.roots = index.roots ?? {};
    for (const sess of sessions) sess.root = sess.cwd ? await gitRoot(sess.cwd, index.roots) : null;
    await pool(sessions.filter((x) => x.file && x.root), MAX_PARALLEL, (sess) =>
      extractFrom(sess, sess.root).catch((e) => {
        sess.memory_error = String(e.message || e).slice(0, 200);
      }),
    );

    // Merge with the index another refresh may have written meanwhile.
    const latest = await readJson(indexFile(), { version: VERSION, files: {} });
    for (const [f, v] of Object.entries(index.files)) if (!latest.files[f] || latest.files[f].offset <= v.offset) latest.files[f] = v;
    latest.roots = { ...(latest.roots ?? {}), ...index.roots };
    await writeJsonAtomic(indexFile(), latest);

    const doc = applyPrefs({ version: VERSION, space, model, updated_at: now, state: sessions.length ? "ready" : "empty", sessions }, await readPrefs(space));
    await writeJsonAtomic(spaceFile(space), doc);
    return doc;
  });
  if (result) return result;
  return { ...(previous ?? { version: VERSION, space, sessions: [], updated_at: null, state: "empty" }), busy: true };
}

const DESCRIBE = {
  name: "herdr-todos",
  version: VERSION,
  commands: {
    refresh: "refresh --space <id> [--state <dir>] [--model <provider/id>] [--force]: read the space's Pi sessions, update and print its task lists",
    show: "show --space <id> [--state <dir>]: print the cached task lists without reading sessions or calling a model",
    order: "order --space <id> --terminals t1,t2,...: set the session order, most important first (sessions not listed follow)",
    priority: "priority --space <id> --terminal <t> --task <key> --level high|normal|low: rank one task (keys are in each task's `key`)",
    memories: "memories --space <id> | --root <folder>: candidate and kept memories for the space's projects (git roots of its Pi sessions)",
    memory: "memory accept|dismiss|edit|remove|restore --root <folder> --id <id> [--text <words>]; memory add --root <folder> --text <words>: accept writes the line to <root>/memories.md and links it from <root>/AGENTS.md; remove deletes the line",
    describe: "this description",
  },
  output: {
    state: "ready | empty (no Pi sessions) | missing (never refreshed); busy: true when another refresh holds the space",
    prefs: "{order: [terminal...], priority: {\"<terminal>|<task key>\": high|low}} chosen by the person",
    sessions: "[{terminal, tab, rank (position in prefs.order or null), status (working|blocked|done|idle|error), name, title, now, tasks: [{text, key, status: in_progress|todo|done|blocked, priority: high|normal|low}], source: board|haiku|none, mapping: label|name|name-newest|cached|newest|none, summarized_at, error}]",
  },
  memory_output: "{projects: [{root, name, file, pending: [{id, text, kind: decision|preference|correction, quote, source, created_at}], accepted: [...], dismissed: count}]}. Candidates come from new prompts in Pi sessions during refresh; memories.md is the authority for kept ones.",
  state_dir: stateDir,
  model,
};

const cmd = args._[0];
try {
  if (cmd === "describe") {
    process.stdout.write(JSON.stringify(DESCRIBE, null, 1) + "\n");
  } else if (cmd === "memories") {
    let roots;
    if (typeof args.root === "string") roots = [path.resolve(expandHome(args.root))];
    else if (typeof args.space === "string") {
      const doc = await readJson(spaceFile(args.space), null);
      roots = [...new Set((doc?.sessions ?? []).map((x) => x.root).filter(Boolean))];
    } else fail("INVALID", "--space <id> or --root <folder> is required");
    process.stdout.write(JSON.stringify({ space: args.space ?? null, projects: await memoriesFor(roots) }) + "\n");
  } else if (cmd === "memory") {
    const action = args._[1];
    if (typeof args.root !== "string") fail("INVALID", "--root <project folder> is required");
    if (action !== "add" && typeof args.id !== "string") fail("INVALID", "--id is required");
    const root = path.resolve(expandHome(args.root));
    const m = await memoryAction(action, root, args.id, typeof args.text === "string" ? args.text : null);
    process.stdout.write(JSON.stringify({ root, memory: m }) + "\n");
  } else if (cmd === "order" || cmd === "priority") {
    if (typeof args.space !== "string") fail("INVALID", "--space <id> is required");
    const prefs = await readPrefs(args.space);
    if (cmd === "order") {
      if (typeof args.terminals !== "string") fail("INVALID", "--terminals t1,t2,... is required");
      prefs.order = [...new Set(args.terminals.split(",").map((x) => x.trim()).filter(Boolean))];
    } else {
      const { terminal, task, level } = args;
      if (typeof terminal !== "string" || typeof task !== "string") fail("INVALID", "--terminal and --task are required");
      if (!LEVELS.includes(level)) fail("INVALID", "--level is high, normal or low");
      const k = `${terminal}|${task}`;
      if (level === "normal") delete prefs.priority[k];
      else prefs.priority[k] = level;
    }
    await writeJsonAtomic(prefsFile(args.space), prefs);
    // Keep the cached lists in step so `show` and the sidebar agree without a refresh.
    const cached = await readJson(spaceFile(args.space), null);
    if (cached) await writeJsonAtomic(spaceFile(args.space), applyPrefs(cached, prefs));
    process.stdout.write(JSON.stringify({ space: args.space, prefs }) + "\n");
  } else if (cmd === "show" || cmd === "refresh") {
    if (typeof args.space !== "string") fail("INVALID", "--space <id> is required (a local Herdr space id, e.g. from `herdr-app status`)");
    if (args.space.includes("/")) fail("UNSUPPORTED", "Spaces on other machines are not supported");
    const doc =
      cmd === "show"
        ? await readJson(spaceFile(args.space), { version: VERSION, space: args.space, sessions: [], updated_at: null, state: "missing" })
        : await refresh(args.space, !!args.force);
    process.stdout.write(JSON.stringify(doc) + "\n");
  } else {
    fail("INVALID", `unknown command ${cmd ?? "(none)"}; try describe`);
  }
} catch (e) {
  fail("FAILED", String(e?.message || e));
}
