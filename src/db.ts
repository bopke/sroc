import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      changed_by_id TEXT NOT NULL,
      changed_by_tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'guild' CHECK (scope IN ('guild', 'dm'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      parent_message_id TEXT REFERENCES messages(message_id),
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      summary TEXT,
      system_prompt_id INTEGER REFERENCES system_prompts(id),
      grok_session_id TEXT,
      workspace_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);

    CREATE TABLE IF NOT EXISTS deploy_notice (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_ids TEXT
    );

    CREATE TABLE IF NOT EXISTS valut_posts (
      message_id TEXT PRIMARY KEY,
      valut_message_id TEXT,
      channel_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  ensureColumn(db, "messages", "grok_session_id", "TEXT");
  ensureColumn(db, "messages", "workspace_id", "TEXT");
  ensureColumn(db, "system_prompts", "scope", "TEXT NOT NULL DEFAULT 'guild'");
  ensureColumn(db, "deploy_notice", "message_ids", "TEXT");
  return db;
}

function ensureColumn(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function defaultDbPath(): string {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = join(projectRoot, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, "bot.db");
}

export const db = openDatabase(defaultDbPath());

export type PromptScope = "guild" | "dm";

export function promptScope(guildId: string | null | undefined): PromptScope {
  return guildId ? "guild" : "dm";
}

export interface SystemPromptRow {
  id: number;
  content: string;
  changed_by_id: string;
  changed_by_tag: string;
  created_at: number;
  scope: PromptScope;
}

export interface MessageRow {
  message_id: string;
  parent_message_id: string | null;
  channel_id: string;
  author_id: string;
  role: "user" | "assistant";
  content: string;
  summary: string | null;
  system_prompt_id: number | null;
  grok_session_id: string | null;
  workspace_id: string | null;
  created_at: number;
}

export function getCurrentSystemPrompt(
  db: DB,
  scope: PromptScope = "guild",
): SystemPromptRow | undefined {
  return db
    .prepare("SELECT * FROM system_prompts WHERE scope = ? ORDER BY id DESC LIMIT 1")
    .get(scope) as SystemPromptRow | undefined;
}

export function getSystemPromptById(db: DB, id: number): SystemPromptRow | undefined {
  return db.prepare("SELECT * FROM system_prompts WHERE id = ?").get(id) as
    SystemPromptRow | undefined;
}

export function insertSystemPrompt(
  db: DB,
  content: string,
  changedById: string,
  changedByTag: string,
  scope: PromptScope = "guild",
): SystemPromptRow {
  const result = db
    .prepare(
      "INSERT INTO system_prompts (content, changed_by_id, changed_by_tag, created_at, scope) VALUES (?, ?, ?, ?, ?)",
    )
    .run(content, changedById, changedByTag, Date.now(), scope);
  return getSystemPromptById(db, Number(result.lastInsertRowid))!;
}

export function listSystemPrompts(
  db: DB,
  limit: number,
  scope: PromptScope = "guild",
): SystemPromptRow[] {
  return db
    .prepare("SELECT * FROM system_prompts WHERE scope = ? ORDER BY id DESC LIMIT ?")
    .all(scope, limit) as SystemPromptRow[];
}

export function getLatestAssistantInChannel(db: DB, channelId: string): MessageRow | undefined {
  return db
    .prepare(
      "SELECT * FROM messages WHERE channel_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
    )
    .get(channelId) as MessageRow | undefined;
}

export function getWorkspaceId(db: DB, messageId: string | null): string | null {
  if (!messageId) return null;
  return getMessage(db, messageId)?.workspace_id ?? null;
}

export function getMessage(db: DB, messageId: string): MessageRow | undefined {
  return db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as
    MessageRow | undefined;
}

export interface DeployNotice {
  channel_id: string;
  message_ids: string[];
}

export function setDeployNotice(db: DB, channelId: string, messageIds: string[]): void {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length === 0) return;
  db.prepare(
    `INSERT INTO deploy_notice (id, channel_id, message_id, message_ids) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_id = excluded.channel_id,
       message_id = excluded.message_id,
       message_ids = excluded.message_ids`,
  ).run(channelId, ids[0], JSON.stringify(ids));
}

function parseNoticeIds(messageId: string, messageIds: string | null | undefined): string[] {
  if (messageIds) {
    try {
      const parsed = JSON.parse(messageIds) as unknown;
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((id) => typeof id === "string" && id.length > 0);
        if (ids.length > 0) return [...new Set(ids)];
      }
    } catch {
      // fall through to legacy single id
    }
  }
  return messageId ? [messageId] : [];
}

export function takeDeployNotice(db: DB): DeployNotice | undefined {
  return db.transaction(() => {
    const row = db
      .prepare("SELECT channel_id, message_id, message_ids FROM deploy_notice WHERE id = 1")
      .get() as { channel_id: string; message_id: string; message_ids: string | null } | undefined;
    if (!row) return undefined;
    db.prepare("DELETE FROM deploy_notice WHERE id = 1").run();
    return {
      channel_id: row.channel_id,
      message_ids: parseNoticeIds(row.message_id, row.message_ids),
    };
  })();
}

export function isAlreadyPostedToValut(db: DB, messageId: string): boolean {
  const row = db.prepare("SELECT 1 FROM valut_posts WHERE message_id = ?").get(messageId);
  return !!row;
}

export function markAsPostedToValut(
  db: DB,
  messageId: string,
  channelId: string,
  valutMessageId?: string,
): void {
  db.prepare(
    `INSERT INTO valut_posts (message_id, channel_id, valut_message_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(messageId, channelId, valutMessageId ?? null, Date.now());
}

export function insertMessage(db: DB, row: Omit<MessageRow, "created_at">): MessageRow {
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO messages
      (message_id, parent_message_id, channel_id, author_id, role, content, summary, system_prompt_id, grok_session_id, workspace_id, created_at)
     VALUES (@message_id, @parent_message_id, @channel_id, @author_id, @role, @content, @summary, @system_prompt_id, @grok_session_id, @workspace_id, @created_at)`,
  ).run({ ...row, created_at: createdAt });
  return { ...row, created_at: createdAt };
}
