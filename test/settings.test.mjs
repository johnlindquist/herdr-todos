import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const helper = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "todos.mjs");
const describe = (env) => JSON.parse(execFileSync("node", [helper, "describe"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "herdr-todos-settings-"));

test("without settings the default models are used", () => {
  const d = describe({ HERDR_TODOS_CONFIG: path.join(tmp(), "none.json") });
  assert.equal(d.model, "anthropic/claude-haiku-4-5");
  assert.equal(d.compose_model, "anthropic/claude-sonnet-5-5");
  assert.equal(d.model_cmd, null);
});

test("the settings file picks the models; the environment wins over it", () => {
  const file = path.join(tmp(), "config.json");
  fs.writeFileSync(file, JSON.stringify({ model: "openai/small", compose_model: "openai/large", model_cmd: ["node", "m.mjs"] }));
  const d = describe({ HERDR_TODOS_CONFIG: file });
  assert.deepEqual([d.model, d.compose_model, d.model_cmd], ["openai/small", "openai/large", '["node","m.mjs"]']);
  assert.equal(describe({ HERDR_TODOS_CONFIG: file, HERDR_TODOS_MODEL: "google/flash" }).model, "google/flash");
});

test("a broken settings file is reported by name, not ignored", () => {
  const file = path.join(tmp(), "config.json");
  fs.writeFileSync(file, "{ not json");
  const r = spawnSync("node", [helper, "describe"], { env: { PATH: process.env.PATH, HERDR_TODOS_CONFIG: file }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error, "INVALID_CONFIG");
});
