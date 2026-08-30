import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { botRoot, clipLog } from "./deploy.js";

describe("clipLog", () => {
  it("returns short text unchanged", () => {
    assert.equal(clipLog("ok", 10), "ok");
  });

  it("keeps the tail of long logs", () => {
    const result = clipLog("abcdefghij", 5);
    assert.equal(result, "…ghij");
  });
});

describe("botRoot", () => {
  it("resolves to the repo root", () => {
    const root = botRoot();
    assert.equal(existsSync(join(root, "package.json")), true);
    assert.equal(existsSync(join(root, "sroc.service")), true);
  });
});
