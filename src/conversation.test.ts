import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { openDatabase, insertMessage, insertSystemPrompt, type DB, type MessageRow } from "./db.js";
import { HISTORY_WINDOW, prepareReplyContext, stripBotMention, type Summarizer } from "./conversation.js";
import type { ChatMessage } from "./grok.js";

let db: DB;
let idCounter = 0;

function nextId(): string {
  idCounter++;
  return `msg-${idCounter}`;
}

function addMessage(
  parentId: string | null,
  role: MessageRow["role"],
  content: string,
  systemPromptId: number | null = null,
): string {
  const id = nextId();
  insertMessage(db, {
    message_id: id,
    parent_message_id: parentId,
    channel_id: "channel-1",
    author_id: role === "user" ? "user-1" : "bot-1",
    role,
    content,
    summary: null,
    system_prompt_id: systemPromptId,
  });
  return id;
}

function countingSummarizer(returnValue = "SUMMARY"): {
  summarizer: Summarizer;
  calls: { existingSummary: string | null; messages: ChatMessage[] }[];
} {
  const calls: { existingSummary: string | null; messages: ChatMessage[] }[] = [];
  const summarizer: Summarizer = async (existingSummary, messages) => {
    calls.push({ existingSummary, messages });
    return returnValue;
  };
  return { summarizer, calls };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  idCounter = 0;
});

after(() => {
  db.close();
});

describe("stripBotMention", () => {
  it("removes the bot's mention token and trims whitespace", () => {
    assert.equal(stripBotMention("<@123> hello there", "123"), "hello there");
    assert.equal(stripBotMention("<@!123> hello there", "123"), "hello there");
    assert.equal(stripBotMention("hello <@123>", "123"), "hello");
  });

  it("leaves other users' mentions untouched", () => {
    assert.equal(stripBotMention("<@999> hello <@123>", "123"), "<@999> hello");
  });
});

describe("prepareReplyContext", () => {
  it("returns no system prompt and empty context for a brand new conversation with none set", async () => {
    const { summarizer, calls } = countingSummarizer();
    const result = await prepareReplyContext(db, null, summarizer);
    assert.equal(result.systemPrompt, null);
    assert.deepEqual(result.contextMessages, []);
    assert.equal(calls.length, 0);
  });

  it("returns the active system prompt for a brand new conversation", async () => {
    insertSystemPrompt(db, "Be concise.", "admin-1", "admin#0001");
    const { summarizer } = countingSummarizer();
    const result = await prepareReplyContext(db, null, summarizer);
    assert.equal(result.systemPrompt, "Be concise.");
  });

  it("returns the full raw chain when under the history window", async () => {
    const prompt = insertSystemPrompt(db, "Be nice.", "admin-1", "admin#0001");
    const root = addMessage(null, "user", "hi", prompt.id);
    const reply1 = addMessage(root, "assistant", "hello!");

    const { summarizer, calls } = countingSummarizer();
    const result = await prepareReplyContext(db, reply1, summarizer);

    assert.equal(result.systemPrompt, "Be nice.");
    assert.deepEqual(result.contextMessages, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ]);
    assert.equal(calls.length, 0);
  });

  it("folds older messages into a summary once the window is exceeded", async () => {
    const prompt = insertSystemPrompt(db, "Be nice.", "admin-1", "admin#0001");
    let parent: string | null = null;
    parent = addMessage(parent, "user", "message 0", prompt.id);
    for (let i = 1; i < HISTORY_WINDOW + 5; i++) {
      parent = addMessage(parent, i % 2 === 0 ? "user" : "assistant", `message ${i}`);
    }

    const { summarizer, calls } = countingSummarizer("condensed summary");
    const result = await prepareReplyContext(db, parent, summarizer);

    assert.equal(calls.length, 1);
    assert.equal(result.contextMessages[0].content, "Summary of earlier conversation:\ncondensed summary");
    assert.equal(result.contextMessages.length, HISTORY_WINDOW + 1);
    const rawMessages = result.contextMessages.slice(1);
    assert.equal(rawMessages[0].content, "message 5");
    assert.equal(rawMessages[rawMessages.length - 1].content, `message ${HISTORY_WINDOW + 4}`);
  });

  it("reuses a cached summary across sibling branches instead of re-summarizing", async () => {
    const prompt = insertSystemPrompt(db, "Be nice.", "admin-1", "admin#0001");
    let parent: string | null = null;
    parent = addMessage(parent, "user", "message 0", prompt.id);
    for (let i = 1; i < HISTORY_WINDOW + 3; i++) {
      parent = addMessage(parent, i % 2 === 0 ? "user" : "assistant", `message ${i}`);
    }
    const sharedAncestor = parent;

    const { summarizer, calls } = countingSummarizer("condensed summary");

    const branchA = addMessage(sharedAncestor, "user", "branch A question");
    const resultA = await prepareReplyContext(db, branchA, summarizer);
    assert.equal(calls.length, 1);

    const branchB = addMessage(sharedAncestor, "user", "branch B question");
    const resultB = await prepareReplyContext(db, branchB, summarizer);

    assert.equal(calls.length, 1, "summarizer should not be called again for the sibling branch");
    assert.equal(resultA.contextMessages[0].content, resultB.contextMessages[0].content);
  });

  it("falls back to the raw window if summarization fails", async () => {
    const prompt = insertSystemPrompt(db, "Be nice.", "admin-1", "admin#0001");
    let parent: string | null = null;
    parent = addMessage(parent, "user", "message 0", prompt.id);
    for (let i = 1; i < HISTORY_WINDOW + 5; i++) {
      parent = addMessage(parent, i % 2 === 0 ? "user" : "assistant", `message ${i}`);
    }

    const failingSummarizer: Summarizer = async () => {
      throw new Error("grok is down");
    };

    const result = await prepareReplyContext(db, parent, failingSummarizer);
    assert.equal(result.contextMessages.length, HISTORY_WINDOW);
    assert.equal(result.contextMessages[0].content, "message 5");
  });
});
