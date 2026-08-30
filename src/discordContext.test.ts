import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatIncomingContent, type FormattableMessage } from "./discordContext.js";

function baseMessage(overrides: Partial<FormattableMessage> = {}): FormattableMessage {
  return {
    author: { username: "jdoe", displayName: "J. Doe" },
    member: null,
    attachments: [],
    embeds: [],
    ...overrides,
  };
}

describe("formatIncomingContent", () => {
  it("prefixes plain text with display name and username", () => {
    const result = formatIncomingContent(baseMessage(), "hello there");
    assert.equal(result, "J. Doe (@jdoe): hello there");
  });

  it("prefers the guild nickname over the global display name", () => {
    const message = baseMessage({ member: { displayName: "Server Nick" } });
    const result = formatIncomingContent(message, "hi");
    assert.equal(result, "Server Nick (@jdoe): hi");
  });

  it("falls back to username when there is no display name", () => {
    const message = baseMessage({ author: { username: "jdoe" } });
    const result = formatIncomingContent(message, "hi");
    assert.equal(result, "jdoe (@jdoe): hi");
  });

  it("includes attachments as text notes", () => {
    const message = baseMessage({
      attachments: [{ name: "photo.png", url: "https://example.com/photo.png" }],
    });
    const result = formatIncomingContent(message, "check this out");
    assert.equal(
      result,
      "J. Doe (@jdoe): check this out\n[Attachment: photo.png](https://example.com/photo.png)",
    );
  });

  it("includes embed title, description, and url", () => {
    const message = baseMessage({
      embeds: [
        { title: "Cool Article", description: "About cool things", url: "https://example.com" },
      ],
    });
    const result = formatIncomingContent(message, "look at this");
    assert.equal(
      result,
      "J. Doe (@jdoe): look at this\n[Cool Article — About cool things] (https://example.com)",
    );
  });

  it("still produces output when there is no text, only attachments", () => {
    const message = baseMessage({
      attachments: [{ name: "file.pdf", url: "https://example.com/file.pdf" }],
    });
    const result = formatIncomingContent(message, "");
    assert.equal(result, "J. Doe (@jdoe): [Attachment: file.pdf](https://example.com/file.pdf)");
  });

  it("falls back to a placeholder when there is nothing at all", () => {
    const result = formatIncomingContent(baseMessage(), "");
    assert.equal(result, "J. Doe (@jdoe): (no content)");
  });
});
