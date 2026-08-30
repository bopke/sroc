import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloneUrlWithToken,
  dockerExecGrokArgs,
  dockerRunArgs,
  gitConfigCommands,
  workspaceContainerName,
  WORKSPACE_LABEL,
} from "./isolate.js";

describe("workspaceContainerName", () => {
  it("prefixes the discord-derived workspace id", () => {
    assert.equal(workspaceContainerName("123"), "sroc-ws-123");
  });
});

describe("cloneUrlWithToken", () => {
  it("leaves the url unchanged without a token", () => {
    assert.equal(
      cloneUrlWithToken("https://github.com/bopke/sroc.git", undefined),
      "https://github.com/bopke/sroc.git",
    );
  });

  it("embeds an x-access-token user without logging in the helper", () => {
    const url = cloneUrlWithToken("https://github.com/bopke/sroc.git", "secret-token");
    assert.equal(url, "https://x-access-token:secret-token@github.com/bopke/sroc.git");
  });
});

describe("dockerRunArgs", () => {
  it("drops capabilities and labels the container", () => {
    const args = dockerRunArgs("sroc-ws-1", {
      image: "sroc-agent:latest",
      repoUrl: "https://github.com/bopke/sroc.git",
      memory: "1g",
      cpus: "1",
      pidsLimit: 256,
      gitUserName: "sroc bot",
      gitUserEmail: "sroc-bot@users.noreply.github.com",
      cloneRepo: false,
    });
    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("ALL"));
    assert.ok(args.includes("--memory"));
    assert.ok(args.includes(`${WORKSPACE_LABEL}=1`));
    assert.equal(args[args.indexOf("--name") + 1], "sroc-ws-1");
    assert.ok(!args.join(" ").includes("DISCORD_TOKEN"));
  });
});

describe("dockerExecGrokArgs", () => {
  it("passes selected env names into the container, not a host cwd", () => {
    const args = dockerExecGrokArgs("sroc-ws-1", ["-p", "hi", "--cwd", "/workspace"]);
    assert.deepEqual(args.slice(0, 3), ["exec", "-e", "XAI_API_KEY"]);
    assert.ok(args.includes("grok"));
    assert.ok(args.includes("/workspace"));
    assert.ok(args.includes("GH_TOKEN"));
    assert.ok(args.includes("GIT_AUTHOR_NAME"));
    assert.ok(!args.includes("DISCORD_TOKEN"));
  });
});

describe("gitConfigCommands", () => {
  it("sets global user identity", () => {
    const cmds = gitConfigCommands("sroc bot", "bot@example.com");
    assert.deepEqual(cmds[0], ["git", "config", "--global", "user.name", "sroc bot"]);
    assert.deepEqual(cmds[1], ["git", "config", "--global", "user.email", "bot@example.com"]);
  });
});
