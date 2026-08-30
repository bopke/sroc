import { getMessage, type DB } from "./db.js";

export function isTrackedAssistantMessage(db: DB, messageId: string): boolean {
  return getMessage(db, messageId)?.role === "assistant";
}

export function stripBotMention(content: string, botUserId: string): string {
  const pattern = new RegExp(`<@!?${botUserId}>`, "g");
  return content.replace(pattern, "").trim();
}

/** Session id of the assistant message being replied to, if this is a continue. */
export function getResumeSessionId(db: DB, parentMessageId: string | null): string | null {
  if (!parentMessageId) return null;
  const parent = getMessage(db, parentMessageId);
  if (parent?.role !== "assistant") return null;
  return parent.grok_session_id;
}

export function buildSessionRules(
  systemPrompt: string | null,
  channelName: string | undefined,
): string {
  const parts = [
    `You are a Discord bot replying in the #${channelName ?? "unknown"} channel.`,
    "You can read, edit, and run code in your workspace when the user asks you to.",
    "Write Discord-friendly replies: concise unless the task needs detail or a code change.",
  ];
  if (systemPrompt) parts.push(systemPrompt);
  return parts.join("\n\n");
}
