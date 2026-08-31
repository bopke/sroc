import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { DISCORD_MESSAGE_LIMIT, splitMessage } from "../discordReply.js";
import { botRoot, clipLog, commandEnv, formatDeployReply } from "./deploy.js";

describe("clipLog", () => {
  it("returns short text unchanged", () => {
    assert.equal(clipLog("ok", 10), "ok");
  });

  it("keeps the tail of long logs", () => {
    const result = clipLog("abcdefghij", 5);
    assert.equal(result, "…ghij");
  });
});

describe("formatDeployReply", () => {
  it("can exceed one Discord message; splitMessage yields valid chunks", () => {
    const huge = "x".repeat(1800);
    const reply = formatDeployReply({
      pull: huge,
      build: huge,
      image: huge,
      deployCmds: huge,
    });
    assert.ok(reply.length > DISCORD_MESSAGE_LIMIT);
    const chunks = splitMessage(reply);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT));
    assert.match(reply, /Restarting\./);
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
