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
      gitUserEmail: "bot@bopke.dev",
      cloneRepo: false,
      xaiProxyUrl: "http://host.docker.internal:9",
    });
    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("ALL"));
    assert.ok(args.includes("--memory"));
    assert.ok(args.includes(`${WORKSPACE_LABEL}=1`));
    assert.equal(args[args.indexOf("--name") + 1], "sroc-ws-1");
    assert.ok(args.includes("host.docker.internal:host-gateway"));
    assert.ok(!args.join(" ").includes("DISCORD_TOKEN"));
  });
});

describe("dockerExecGrokArgs", () => {
  it("does not pass real API or GitHub tokens into the grok process", () => {
    const args = dockerExecGrokArgs(
      "sroc-ws-1",
      ["-p", "hi", "--cwd", "/workspace"],
      "http://host.docker.internal:9",
    );
    const joined = args.join(" ");
    assert.ok(args.includes("grok"));
    assert.ok(joined.includes("XAI_API_KEY=sroc-local"));
    assert.ok(joined.includes("GROK_XAI_API_BASE_URL=http://host.docker.internal:9"));
    assert.ok(!joined.includes("GH_TOKEN"));
    assert.ok(!joined.includes("GITHUB_TOKEN"));
    assert.ok(!joined.includes("DISCORD_TOKEN"));
    assert.ok(!joined.includes("xai-"));
  });
});

describe("gitConfigCommands", () => {
  it("sets global user identity", () => {
    const cmds = gitConfigCommands("sroc bot", "bot@example.com");
    assert.deepEqual(cmds[0], ["git", "config", "--global", "user.name", "sroc bot"]);
    assert.deepEqual(cmds[1], ["git", "config", "--global", "user.email", "bot@example.com"]);
  });
});
