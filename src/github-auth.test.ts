import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createGithubAuth, ghAuthEnv, ghHostsPath } from "./github-auth.js";

function homeWithHosts(): string {
  const home = mkdtempSync(join(tmpdir(), "sroc-gh-"));
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(ghHostsPath(home), "github.com:\n    user: bot\n");
  return home;
}

describe("ghAuthEnv", () => {
  it("sets HOME and drops GH_TOKEN / GITHUB_TOKEN so gh reads hosts.yml", () => {
    const env = ghAuthEnv("/root", {
      HOME: "/old",
      GH_TOKEN: "stale-gh",
      GITHUB_TOKEN: "stale-github",
      PATH: "/bin",
    });
    assert.equal(env.HOME, "/root");
    assert.equal(env.PATH, "/bin");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });
});

describe("createGithubAuth", () => {
  it("prefers the host gh session over GITHUB_TOKEN", async () => {
    const auth = createGithubAuth({
      home: homeWithHosts(),
      envToken: "env-token",
      readGhToken: async () => "gh-session-token",
    });
    assert.equal(auth.hasAny(), true);
    assert.equal(await auth.getBearer(), "gh-session-token");
    assert.equal(auth.source(), "gh");
    assert.equal(auth.label(), "gh auth (host)");
  });

  it("falls back to GITHUB_TOKEN when gh is not logged in", async () => {
    const home = mkdtempSync(join(tmpdir(), "sroc-gh-"));
    const auth = createGithubAuth({
      home,
      envToken: "env-token",
      readGhToken: async () => undefined,
    });
    assert.equal(auth.hasAny(), true);
    assert.equal(await auth.getBearer(), "env-token");
    assert.equal(auth.source(), "env");
    assert.equal(auth.label(), "GITHUB_TOKEN");
  });

  it("hasAny is true when only hosts.yml exists", () => {
    const auth = createGithubAuth({
      home: homeWithHosts(),
      readGhToken: async () => "gh-session-token",
    });
    assert.equal(auth.hasAny(), true);
    assert.equal(auth.source(), "gh");
  });

  it("hasAny is false with neither a session nor an env token", () => {
    const home = mkdtempSync(join(tmpdir(), "sroc-gh-"));
    const auth = createGithubAuth({ home, readGhToken: async () => undefined });
    assert.equal(auth.hasAny(), false);
    assert.equal(auth.source(), "none");
  });

  it("throws when no credential can be resolved", async () => {
    const home = mkdtempSync(join(tmpdir(), "sroc-gh-"));
    const auth = createGithubAuth({ home, readGhToken: async () => undefined });
    await assert.rejects(auth.getBearer(), /gh auth login/);
  });

  it("re-reads gh when hosts.yml changes", async () => {
    const home = homeWithHosts();
    let n = 0;
    const auth = createGithubAuth({
      home,
      readGhToken: async () => {
        n += 1;
        return `token-${n}`;
      },
    });
    assert.equal(await auth.getBearer(), "token-1");
    assert.equal(await auth.getBearer(), "token-1");
    writeFileSync(ghHostsPath(home), "github.com:\n    user: bot\n    # refreshed\n");
    assert.equal(await auth.getBearer(), "token-2");
    assert.equal(n, 2);
  });
});
