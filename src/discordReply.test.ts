import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISCORD_MESSAGE_LIMIT, splitMessage } from "./discordReply.js";

describe("splitMessage", () => {
  it("returns a single chunk when under the limit", () => {
    assert.deepEqual(splitMessage("hello"), ["hello"]);
  });

  it("splits on the nearest preceding newline", () => {
    const a = "a".repeat(10);
    const b = "b".repeat(10);
    assert.deepEqual(splitMessage(`${a}\n${b}`, 15), [a, b]);
  });

  it("hard-splits when there is no newline", () => {
    const text = "x".repeat(25);
    const chunks = splitMessage(text, 10);
    assert.deepEqual(chunks, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    assert.ok(chunks.every((chunk) => chunk.length <= 10));
  });

  it("never emits a chunk over Discord's limit", () => {
    const text = `${"line\n".repeat(500)}${"z".repeat(3000)}`;
    const chunks = splitMessage(text);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT));
  });
});
