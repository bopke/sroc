import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import {
  botRoot,
  clipDiscordReply,
  clipLog,
  commandEnv,
  DISCORD_REPLY_LIMIT,
  formatDeployReply,
} from "./deploy.js";

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
  it("stays within Discord's 2000-character limit even with huge step logs", () => {
    const huge = "x".repeat(5000);
    const reply = formatDeployReply({
      pull: huge,
      build: huge,
      image: huge,
      deployCmds: huge,
    });
    assert.ok(reply.length <= DISCORD_REPLY_LIMIT);
    assert.match(reply, /Restarting\./);
  });

  it("clipDiscordReply caps an arbitrary failure message", () => {
    const reply = clipDiscordReply(`Deploy failed.\n${"y".repeat(5000)}`);
    assert.equal(reply.length, DISCORD_REPLY_LIMIT);
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
