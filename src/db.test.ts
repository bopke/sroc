import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import {
  getCurrentSystemPrompt,
  insertSystemPrompt,
  listSystemPrompts,
  openDatabase,
  promptScope,
  setDeployNotice,
  takeDeployNotice,
  type DB,
} from "./db.js";

let db: DB;

beforeEach(() => {
  db = openDatabase(":memory:");
});

after(() => {
  db.close();
});

describe("promptScope", () => {
  it("is guild when a guild id is present, otherwise dm", () => {
    assert.equal(promptScope("guild-1"), "guild");
    assert.equal(promptScope(null), "dm");
    assert.equal(promptScope(undefined), "dm");
  });
});

describe("system prompt scopes", () => {
  it("keeps guild and dm prompts independent", () => {
    insertSystemPrompt(db, "Guild voice.", "u1", "u#1", "guild");
    insertSystemPrompt(db, "DM voice.", "u1", "u#1", "dm");

    assert.equal(getCurrentSystemPrompt(db, "guild")?.content, "Guild voice.");
    assert.equal(getCurrentSystemPrompt(db, "dm")?.content, "DM voice.");
  });

  it("does not leak a later guild prompt into the dm current prompt", () => {
    insertSystemPrompt(db, "DM first.", "u1", "u#1", "dm");
    insertSystemPrompt(db, "Guild later.", "u1", "u#1", "guild");

    assert.equal(getCurrentSystemPrompt(db, "dm")?.content, "DM first.");
    assert.equal(getCurrentSystemPrompt(db)?.content, "Guild later.");
  });

  it("lists history only for the requested scope", () => {
    insertSystemPrompt(db, "G1", "u1", "u#1", "guild");
    insertSystemPrompt(db, "D1", "u1", "u#1", "dm");
    insertSystemPrompt(db, "G2", "u1", "u#1", "guild");

    const guild = listSystemPrompts(db, 10, "guild").map((row) => row.content);
    const dm = listSystemPrompts(db, 10, "dm").map((row) => row.content);
    assert.deepEqual(guild, ["G2", "G1"]);
    assert.deepEqual(dm, ["D1"]);
  });
});

describe("deploy notice", () => {
  it("stores one notice and take removes it", () => {
    setDeployNotice(db, "chan-1", "msg-1");
    setDeployNotice(db, "chan-2", "msg-2");
    assert.deepEqual(takeDeployNotice(db), { channel_id: "chan-2", message_id: "msg-2" });
    assert.equal(takeDeployNotice(db), undefined);
  });
});
