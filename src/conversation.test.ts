import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { insertMessage, insertSystemPrompt, openDatabase, type DB, type MessageRow } from "./db.js";
import {
  buildSessionRules,
  getResumeSessionId,
  isAllowedSource,
  isTrackedAssistantMessage,
  resolveChatTarget,
  stripBotMention,
} from "./conversation.js";

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
  extras: {
    systemPromptId?: number | null;
    grokSessionId?: string | null;
    workspaceId?: string | null;
    channelId?: string;
  } = {},
): string {
  const id = nextId();
  insertMessage(db, {
    message_id: id,
    parent_message_id: parentId,
    channel_id: extras.channelId ?? "channel-1",
    author_id: role === "user" ? "user-1" : "bot-1",
    role,
    content,
    summary: null,
    system_prompt_id: extras.systemPromptId ?? null,
    grok_session_id: extras.grokSessionId ?? null,
    workspace_id: extras.workspaceId ?? null,
  });
  return id;
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

describe("isTrackedAssistantMessage", () => {
  it("is true only for stored assistant messages", () => {
    const prompt = insertSystemPrompt(db, "Be nice.", "admin-1", "admin#0001");
    const user = addMessage(null, "user", "hi", { systemPromptId: prompt.id });
    const assistant = addMessage(user, "assistant", "hello", { grokSessionId: "sess-1" });

    assert.equal(isTrackedAssistantMessage(db, assistant), true);
    assert.equal(isTrackedAssistantMessage(db, user), false);
    assert.equal(isTrackedAssistantMessage(db, "missing"), false);
  });
});

describe("getResumeSessionId", () => {
  it("returns null for a new conversation", () => {
    assert.equal(getResumeSessionId(db, null), null);
  });

  it("returns the assistant message's Grok Build session id", () => {
    const user = addMessage(null, "user", "hi");
    const assistant = addMessage(user, "assistant", "hello", { grokSessionId: "sess-abc" });
    assert.equal(getResumeSessionId(db, assistant), "sess-abc");
  });

  it("returns null when the parent has no session (legacy row)", () => {
    const user = addMessage(null, "user", "hi");
    const assistant = addMessage(user, "assistant", "hello");
    assert.equal(getResumeSessionId(db, assistant), null);
  });

  it("returns null for a user parent", () => {
    const user = addMessage(null, "user", "hi");
    assert.equal(getResumeSessionId(db, user), null);
  });
});

describe("buildSessionRules", () => {
  it("includes the channel name and optional system prompt", () => {
    const rules = buildSessionRules("Be concise.", "general");
    assert.match(rules, /#general/);
    assert.match(rules, /Be concise\./);
  });

  it("works without a system prompt", () => {
    const rules = buildSessionRules(null, undefined);
    assert.match(rules, /#unknown/);
    assert.doesNotMatch(rules, /null/);
  });

  it("describes a DM instead of a channel when dm is set", () => {
    const rules = buildSessionRules("Be brief.", undefined, { dm: true });
    assert.match(rules, /DM/);
    assert.doesNotMatch(rules, /#unknown/);
    assert.match(rules, /Be brief\./);
  });
});

describe("isAllowedSource", () => {
  const ids = {
    configuredGuildId: "guild-1",
    ownerId: "owner-1",
  };

  it("allows the configured guild", () => {
    assert.equal(isAllowedSource({ ...ids, guildId: "guild-1", authorId: "anyone" }), true);
  });

  it("rejects other guilds", () => {
    assert.equal(isAllowedSource({ ...ids, guildId: "guild-2", authorId: "owner-1" }), false);
  });

  it("allows DMs from the owner only", () => {
    assert.equal(isAllowedSource({ ...ids, guildId: null, authorId: "owner-1" }), true);
    assert.equal(isAllowedSource({ ...ids, guildId: null, authorId: "stranger" }), false);
  });
});

describe("resolveChatTarget", () => {
  it("ignores guild messages that are not a mention or a reply to the bot", () => {
    assert.equal(
      resolveChatTarget(db, {
        repliedToId: undefined,
        mentionedBot: false,
        isDm: false,
        channelId: "channel-1",
      }),
      null,
    );
  });

  it("starts a new conversation on mention", () => {
    assert.deepEqual(
      resolveChatTarget(db, {
        repliedToId: undefined,
        mentionedBot: true,
        isDm: false,
        channelId: "channel-1",
      }),
      { parentMessageId: null, resumeSessionId: null },
    );
  });

  it("starts a new DM conversation when there is no prior assistant message", () => {
    assert.deepEqual(
      resolveChatTarget(db, {
        repliedToId: undefined,
        mentionedBot: false,
        isDm: true,
        channelId: "dm-1",
      }),
      { parentMessageId: null, resumeSessionId: null },
    );
  });

  it("continues the latest assistant in a DM when the user does not reply or mention", () => {
    const user = addMessage(null, "user", "hi", { channelId: "dm-1" });
    const assistant = addMessage(user, "assistant", "hello", {
      channelId: "dm-1",
      grokSessionId: "sess-dm",
    });
    addMessage(assistant, "user", "other channel", { channelId: "dm-2" });
    addMessage(null, "assistant", "elsewhere", {
      channelId: "dm-2",
      grokSessionId: "sess-other",
    });

    assert.deepEqual(
      resolveChatTarget(db, {
        repliedToId: undefined,
        mentionedBot: false,
        isDm: true,
        channelId: "dm-1",
      }),
      { parentMessageId: assistant, resumeSessionId: "sess-dm" },
    );
  });

  it("starts a new DM conversation when the owner mentions the bot", () => {
    const user = addMessage(null, "user", "hi", { channelId: "dm-1" });
    addMessage(user, "assistant", "hello", { channelId: "dm-1", grokSessionId: "sess-dm" });

    assert.deepEqual(
      resolveChatTarget(db, {
        repliedToId: undefined,
        mentionedBot: true,
        isDm: true,
        channelId: "dm-1",
      }),
      { parentMessageId: null, resumeSessionId: null },
    );
  });
});
