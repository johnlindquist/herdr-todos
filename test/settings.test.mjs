import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const helper = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "todos.mjs");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-todos-settings-")));
// A user settings file and a project folder, both in a temp folder; nothing of the real home is read.
function setup(user, project) {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const root = path.join(dir, "project");
  fs.mkdirSync(path.join(root, ".herdr"), { recursive: true });
  if (user !== undefined) fs.writeFileSync(file, typeof user === "string" ? user : JSON.stringify(user));
  if (project !== undefined) fs.writeFileSync(path.join(root, ".herdr", "todos.json"), JSON.stringify(project));
  return { file, root };
}
function run(argv, { file, root }, env = {}) {
  const r = spawnSync("node", [helper, ...argv], { cwd: root, env: { PATH: process.env.PATH, HERDR_TODOS_CONFIG: file, ...env }, encoding: "utf8" });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null };
}

test("order: defaults, then the user file, then the project file, then the environment", () => {
  const none = setup();
  assert.deepEqual(run(["config", "--project", none.root], none).out.settings.model, { value: "anthropic/claude-haiku-5-5", from: "default" });
  const user = setup({ model: "openai/small", thinking: "low" });
  let s = run(["config", "--project", user.root], user).out.settings;
  assert.deepEqual([s.model, s.thinking], [{ value: "openai/small", from: "user file" }, { value: "low", from: "user file" }]);
  const both = setup({ model: "openai/small", thinking: "low" }, { model: "google/flash" });
  s = run(["config", "--project", both.root], both).out.settings;
  assert.deepEqual([s.model, s.thinking], [{ value: "google/flash", from: "project file" }, { value: "low", from: "user file" }]);
  s = run(["config", "--project", both.root], both, { HERDR_TODOS_MODEL: "xai/fast", HERDR_TODOS_REFRESH_SECONDS: "45" }).out.settings;
  assert.deepEqual([s.model, s.refreshSeconds], [{ value: "xai/fast", from: "environment (HERDR_TODOS_MODEL)" }, { value: 45, from: "environment (HERDR_TODOS_REFRESH_SECONDS)" }]);
});

test("an unknown key and a bad value are reported by name; the other values still count", () => {
  const s = setup({ model: "openai/small", colour: "red", thinking: "loud" });
  const { status, out } = run(["config"], s);
  assert.equal(status, 0);
  assert.equal(out.settings.model.value, "openai/small");
  assert.equal(out.settings.thinking.value, "off");
  assert.deepEqual(out.problems.map((p) => [p.error, p.key]), [["UNKNOWN_KEY", "colour"], ["INVALID_VALUE", "thinking"]]);
  assert.match(out.problems[0].message, /config\.json: unknown key "colour"/);
});

test("a broken file is a named problem and the defaults are used", () => {
  const s = setup("{ not json");
  const { status, out } = run(["config"], s);
  assert.equal(status, 0);
  assert.equal(out.problems[0].error, "INVALID_CONFIG");
  assert.match(out.problems[0].message, /config\.json can't be read/);
  assert.equal(out.settings.model.from, "default");
  const set = run(["config", "set", "model", "openai/small"], s);
  assert.deepEqual([set.status, set.err.error], [1, "INVALID_CONFIG"], "config set never overwrites a file it cannot read");
});

test("config set checks the value, writes the user or the project file, and config path names both", () => {
  const s = setup();
  assert.deepEqual(run(["config", "path", "--project", s.root], s).out, { user: s.file, project: path.join(s.root, ".herdr", "todos.json") });
  assert.equal(run(["config", "set", "model", "haiku"], s).err.error, "INVALID_VALUE");
  assert.equal(run(["config", "set", "colour", "red"], s).err.error, "UNKNOWN_KEY");
  assert.equal(run(["config", "set", "refreshSeconds", "1"], s).err.error, "INVALID_VALUE");
  assert.equal(fs.existsSync(s.file), false, "nothing was written for refused values");
  const set = run(["config", "set", "model", "openai/small"], s);
  assert.deepEqual(set.out.changed, { file: s.file, key: "model", value: "openai/small" });
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), { model: "openai/small" });
  const proj = run(["config", "set", "refreshSeconds", "90", "--project", s.root], s);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.root, ".herdr", "todos.json"), "utf8")), { refreshSeconds: 90 });
  assert.deepEqual([proj.out.settings.refreshSeconds, proj.out.settings.model.from], [{ value: 90, from: "project file" }, "user file"]);
  run(["config", "unset", "model"], s);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")), {});
});

test("describe lists every key with its type, default, meaning and variable", () => {
  const d = run(["describe"], setup()).out;
  for (const key of ["model", "thinking", "refreshSeconds"]) assert.ok(d.settings[key].type && d.settings[key].meaning && d.settings[key].environment.length, key);
  assert.equal(d.settings.model.default, "anthropic/claude-haiku-5-5");
});

test("the earlier names still work: model_cmd in the file, HERDR_TODOS_MODEL and HERDR_TODOS_MODEL_CMD", () => {
  const s = setup({ model_cmd: ["node", "m.mjs"] });
  assert.deepEqual(run(["config"], s).out.settings.modelCmd, { value: ["node", "m.mjs"], from: "user file" });
  const e = run(["config"], s, { HERDR_TODOS_MODEL: "google/flash", HERDR_TODOS_MODEL_CMD: '["sh","x.sh"]' }).out.settings;
  assert.deepEqual([e.model.value, e.modelCmd.value], ["google/flash", ["sh", "x.sh"]]);
});
