import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGrokArgs, parseStreamLine, reduceStdout } from "./grok.js";

describe("buildGrokArgs", () => {
  const base = {
    prompt: "hello",
    model: "grok-build",
    cwd: "/tmp/workspace",
    alwaysApprove: true,
    sandbox: "workspace",
  };

  it("starts a new session with streaming-json and sandbox", () => {
    assert.deepEqual(buildGrokArgs(base), [
      "-p",
      "hello",
      "-m",
      "grok-build",
      "--cwd",
      "/tmp/workspace",
      "--output-format",
      "streaming-json",
      "--verbatim",
      "--always-approve",
      "--sandbox",
      "workspace",
    ]);
  });

  it("resumes and forks so Discord branches do not mutate the parent session", () => {
    const args = buildGrokArgs({
      ...base,
      resumeSessionId: "sess-1",
      fork: true,
    });
    assert.ok(args.includes("--resume"));
    assert.equal(args[args.indexOf("--resume") + 1], "sess-1");
    assert.ok(args.includes("--fork-session"));
  });

  it("passes rules only when provided", () => {
    const withRules = buildGrokArgs({ ...base, rules: "Be nice." });
    assert.ok(withRules.includes("--rules"));
    assert.equal(withRules[withRules.indexOf("--rules") + 1], "Be nice.");

    const without = buildGrokArgs(base);
    assert.ok(!without.includes("--rules"));
  });

  it("omits sandbox and always-approve when disabled", () => {
    const args = buildGrokArgs({ ...base, alwaysApprove: false, sandbox: "off" });
    assert.ok(!args.includes("--always-approve"));
    assert.ok(!args.includes("--sandbox"));
  });
});

describe("parseStreamLine / reduceStdout", () => {
  it("concatenates text chunks and captures the session id from end", () => {
    const result = reduceStdout(
      [
        JSON.stringify({ type: "text", data: "Hello " }),
        JSON.stringify({ type: "tool_call", title: "Read", toolName: "read_file" }),
        JSON.stringify({ type: "text", data: "world" }),
        JSON.stringify({ type: "end", sessionId: "sess-9" }),
      ].join("\n"),
    );
    assert.equal(result.text, "Hello world");
    assert.equal(result.sessionId, "sess-9");
    assert.equal(result.error, null);
  });

  it("parses a non-streaming json result object", () => {
    const result = reduceStdout(JSON.stringify({ text: "hi", sessionId: "sess-2" }));
    assert.equal(result.text, "hi");
    assert.equal(result.sessionId, "sess-2");
  });

  it("records error events", () => {
    const result = reduceStdout(JSON.stringify({ type: "error", message: "auth failed" }));
    assert.equal(result.error, "auth failed");
  });

  it("ignores blank lines, thoughts, and invalid json", () => {
    assert.equal(parseStreamLine(""), null);
    assert.equal(parseStreamLine("not json"), null);
    assert.equal(parseStreamLine(JSON.stringify({ type: "thought", data: "hmm" })), null);
  });
});
