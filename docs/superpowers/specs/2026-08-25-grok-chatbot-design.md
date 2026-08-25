# Grok-backed chatbot design

## Purpose

Turn the bot into a conversational chatbot backed by xAI's Grok API. Users start a
conversation by @mentioning the bot; replying to one of the bot's messages continues
that conversation with full awareness of prior turns. A slash command lets anyone
view, change, and audit the system prompt that shapes the bot's behavior.

## Scope constraints

- The bot operates in exactly one Discord guild, configured via `DISCORD_GUILD_ID`.
  Messages from any other guild, and all DMs, are ignored.
- No standalone database server — persistence is a local SQLite file.
- Anyone can view or change the system prompt; no permission gate.

## Data model (SQLite via `better-sqlite3`)

File: `data/bot.db` (gitignored).

```sql
CREATE TABLE system_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  changed_by_id TEXT NOT NULL,
  changed_by_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  parent_message_id TEXT REFERENCES messages(message_id),
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  summary TEXT,
  system_prompt_id INTEGER REFERENCES system_prompts(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_parent ON messages(parent_message_id);
```

Notes:

- `message_id` is the Discord snowflake of the message that node represents.
- `parent_message_id` is null only for root messages (conversation starts).
- `system_prompt_id` is set **only on root messages**, to whichever
  `system_prompts` row is current at the moment the root is created (null if no
  system prompt has ever been set). All descendants inherit this by walking to
  their root — a later `/systemprompt set` never changes an in-flight
  conversation's prompt.
- `summary` is populated lazily on whichever node currently marks the boundary
  of the raw-message window (see "Context building" below). Most nodes have a
  null summary.
- The `system_prompts` table's latest row (by `id`/`created_at`) is the
  globally active prompt for any *new* root created after that point. If the
  table is empty, new conversations run with no system prompt at all.

## Context building (tree walk + rolling summary)

Given a leaf message (the one just received, or the one about to be replied
to), building the Grok request context means:

1. Walk `parent_message_id` pointers back from the leaf, collecting raw
   `(role, content)` pairs, until either:
   - 10 raw messages have been collected, or
   - the root is reached (no parent).
2. If more ancestors remain beyond that 10-message window:
   - If the next ancestor beyond the window already has a non-null `summary`,
     use it directly as a synthetic leading system/user note ("Summary of
     earlier conversation: ...") and stop walking.
   - If it doesn't (the window just slid past it for the first time), call
     `grok.summarize(nearestCachedAncestorSummary, messagesBetween)` — folding
     any existing ancestor summary plus the raw messages between it and this
     boundary node into one new summary — and cache the result on that
     boundary node. This makes the summarization cost proportional to how far
     the window slid, not to total conversation length, and the cached result
     is reusable by any sibling branch that shares that ancestor.
3. Resolve the root's `system_prompt_id` → `system_prompts.content` (or omit
   the system message if null).
4. Send: `[system prompt?, summary note?, ...windowed raw messages]` to Grok.

Branching: if two different users each reply to the same bot message, each
reply becomes a new leaf with the same `parent_message_id`. They share
identical context up to that point and diverge from there — no special-casing
needed, this falls out of the tree walk.

## Message trigger logic

On every `MessageCreate` event:

1. Ignore if not in the configured guild, or if it's a DM, or if the author is
   a bot.
2. If `message.reference` points at a message tracked in `messages` with
   `role = 'assistant'` → **continue**: `parent_message_id` = that message's
   id. (A mention in this message is irrelevant to routing; it's just text.)
3. Else if the message mentions the bot's user → **start new**:
   `parent_message_id` = null. The mention token is stripped from the stored
   content.
4. Else → ignore, nothing is recorded.

For a handled message: insert the incoming message as a `user` node, build
context per above, call Grok, send the reply via `message.reply(...)` (so the
sent message's id becomes the new leaf's parent for future replies), and
insert the bot's reply as an `assistant` node with `parent_message_id` set to
the user node just inserted.

Replies longer than Discord's 2000-character limit are split on the nearest
preceding newline into sequential messages sent in order; only the final
chunk is a "reply" (establishes the reply-chain reference) and is the only
chunk recorded as the `assistant` node in `messages`. Earlier chunks are sent
as plain follow-ups in the same channel immediately before it and are not
individually trackable — a reply to one of them is not recognized as
continuing the conversation (falls through to the "ignore" case, or starts a
fresh conversation if it also mentions the bot).

## Slash command: `/systemprompt`

- `/systemprompt view` — ephemeral. Shows the current active prompt, or "No
  system prompt is currently set." if the table is empty.
- `/systemprompt set <text>` — inserts a new `system_prompts` row. Replies
  **publicly**, showing the previous prompt (or "none"), the new prompt, and
  who changed it.
- `/systemprompt history [count]` — ephemeral. Lists the last `count` (default
  5, max e.g. 20) entries: content (truncated), changed-by, timestamp.

## Grok integration

`src/grok.ts` wraps the `openai` npm SDK configured with `baseURL:
"https://api.x.ai/v1"` and `apiKey: config.grokApiKey` (xAI's API is
OpenAI-compatible). Two functions:

- `chat(systemPrompt: string | null, messages: {role, content}[]): Promise<string>`
- `summarize(existingSummary: string | null, messages: {role, content}[]): Promise<string>`
  — uses a small fixed instruction prompt asking for a concise running summary.

## Config additions (`src/config.ts`)

- `GROK_API_KEY` (required)
- `GROK_MODEL` (optional, default `"grok-3"`)
- `DISCORD_GUILD_ID` becomes **required** (previously optional) — it now also
  gates which guild the bot responds in, not just command deploy scoping.

No `DEFAULT_SYSTEM_PROMPT` — a fresh bot instance runs with no system prompt
until someone sets one via the slash command.

## Error handling

- Grok API call fails: log the error, reply with a short apology message, and
  do **not** persist a node for the failed turn (so a retry-by-reply lands on
  the same valid parent, not a dead end).
- Summarization call fails: log the error and fall back to sending the raw
  window without a summary note for that turn (best-effort, non-fatal).

## Testing

Discord I/O is not practically unit-testable. `src/conversation.ts` (tree
walk, window selection, summary-fold triggering) gets unit tests via Node's
built-in `node --test`, using a throwaway in-memory `better-sqlite3` instance
per test and a stubbed Grok summarizer. Covered cases: linear history under
and over the 10-message window, branching from a shared ancestor, and summary
cache reuse across siblings.
