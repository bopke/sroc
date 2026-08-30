import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { botRoot, clipLog, commandEnv } from "./deploy.js";

describe("clipLog", () => {
  it("returns short text unchanged", () => {
    assert.equal(clipLog("ok", 10), "ok");
  });

  it("keeps the tail of long logs", () => {
    const result = clipLog("abcdefghij", 5);
    assert.equal(result, "…ghij");
  });
});

describe("commandEnv", () => {
  it("sets HOME so git can use gh credentials under systemd", () => {
    const env = commandEnv();
    assert.equal(env.HOME, homedir());
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });
});

describe("botRoot", () => {
  it("resolves to the repo root", () => {
    const root = botRoot();
    assert.equal(existsSync(join(root, "package.json")), true);
    assert.equal(existsSync(join(root, "sroc.service")), true);
  });
});
