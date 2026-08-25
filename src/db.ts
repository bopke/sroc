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
      created_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
  `);
  return db;
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

export interface SystemPromptRow {
  id: number;
  content: string;
  changed_by_id: string;
  changed_by_tag: string;
  created_at: number;
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
  created_at: number;
}

export function getCurrentSystemPrompt(db: DB): SystemPromptRow | undefined {
  return db
    .prepare("SELECT * FROM system_prompts ORDER BY id DESC LIMIT 1")
    .get() as SystemPromptRow | undefined;
}

export function getSystemPromptById(db: DB, id: number): SystemPromptRow | undefined {
  return db.prepare("SELECT * FROM system_prompts WHERE id = ?").get(id) as
    | SystemPromptRow
    | undefined;
}

export function insertSystemPrompt(
  db: DB,
  content: string,
  changedById: string,
  changedByTag: string,
): SystemPromptRow {
  const result = db
    .prepare(
      "INSERT INTO system_prompts (content, changed_by_id, changed_by_tag, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(content, changedById, changedByTag, Date.now());
  return getSystemPromptById(db, Number(result.lastInsertRowid))!;
}

export function listSystemPrompts(db: DB, limit: number): SystemPromptRow[] {
  return db
    .prepare("SELECT * FROM system_prompts ORDER BY id DESC LIMIT ?")
    .all(limit) as SystemPromptRow[];
}

export function getMessage(db: DB, messageId: string): MessageRow | undefined {
  return db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as
    | MessageRow
    | undefined;
}

export function insertMessage(db: DB, row: Omit<MessageRow, "created_at">): MessageRow {
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO messages
      (message_id, parent_message_id, channel_id, author_id, role, content, summary, system_prompt_id, created_at)
     VALUES (@message_id, @parent_message_id, @channel_id, @author_id, @role, @content, @summary, @system_prompt_id, @created_at)`,
  ).run({ ...row, created_at: createdAt });
  return { ...row, created_at: createdAt };
}

export function setMessageSummary(db: DB, messageId: string, summary: string): void {
  db.prepare("UPDATE messages SET summary = ? WHERE message_id = ?").run(summary, messageId);
}
