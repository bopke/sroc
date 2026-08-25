import {
  getCurrentSystemPrompt,
  getMessage,
  getSystemPromptById,
  setMessageSummary,
  type DB,
  type MessageRow,
} from "./db.js";
import type { ChatMessage } from "./grok.js";

export const HISTORY_WINDOW = 10;

export type Summarizer = (
  existingSummary: string | null,
  messages: ChatMessage[],
) => Promise<string>;

export interface ReplyContext {
  systemPrompt: string | null;
  contextMessages: ChatMessage[];
}

function toChatMessage(row: MessageRow): ChatMessage {
  return { role: row.role, content: row.content };
}

/** Walks parent pointers from `leafId` back to the root, returning root-to-leaf order. */
function walkChain(db: DB, leafId: string): MessageRow[] {
  const chain: MessageRow[] = [];
  let currentId: string | null = leafId;
  while (currentId) {
    const msg = getMessage(db, currentId);
    if (!msg) break;
    chain.unshift(msg);
    currentId = msg.parent_message_id;
  }
  return chain;
}

export function isTrackedAssistantMessage(db: DB, messageId: string): boolean {
  return getMessage(db, messageId)?.role === "assistant";
}

export function stripBotMention(content: string, botUserId: string): string {
  const pattern = new RegExp(`<@!?${botUserId}>`, "g");
  return content.replace(pattern, "").trim();
}

/**
 * Builds the {systemPrompt, contextMessages} to send to Grok for a reply
 * whose parent is `parentMessageId` (null means: brand new conversation).
 */
export async function prepareReplyContext(
  db: DB,
  parentMessageId: string | null,
  summarize: Summarizer,
): Promise<ReplyContext> {
  if (parentMessageId === null) {
    const current = getCurrentSystemPrompt(db);
    return { systemPrompt: current?.content ?? null, contextMessages: [] };
  }

  const chain = walkChain(db, parentMessageId);
  if (chain.length === 0) {
    return { systemPrompt: null, contextMessages: [] };
  }

  const root = chain[0];
  const systemPrompt =
    root.system_prompt_id != null ? (getSystemPromptById(db, root.system_prompt_id)?.content ?? null) : null;

  if (chain.length <= HISTORY_WINDOW) {
    return { systemPrompt, contextMessages: chain.map(toChatMessage) };
  }

  const older = chain.slice(0, chain.length - HISTORY_WINDOW);
  const windowed = chain.slice(chain.length - HISTORY_WINDOW);
  const boundary = older[older.length - 1];

  if (boundary.summary) {
    return {
      systemPrompt,
      contextMessages: [summaryNote(boundary.summary), ...windowed.map(toChatMessage)],
    };
  }

  let cachedAncestorIndex = -1;
  for (let i = older.length - 2; i >= 0; i--) {
    if (older[i].summary) {
      cachedAncestorIndex = i;
      break;
    }
  }
  const baseSummary = cachedAncestorIndex >= 0 ? older[cachedAncestorIndex].summary : null;
  const toFold = older.slice(cachedAncestorIndex + 1);

  try {
    const freshSummary = await summarize(baseSummary, toFold.map(toChatMessage));
    setMessageSummary(db, boundary.message_id, freshSummary);
    return {
      systemPrompt,
      contextMessages: [summaryNote(freshSummary), ...windowed.map(toChatMessage)],
    };
  } catch (error) {
    console.error("Summarization failed, falling back to raw window:", error);
    return { systemPrompt, contextMessages: windowed.map(toChatMessage) };
  }
}

function summaryNote(summary: string): ChatMessage {
  return { role: "user", content: `Summary of earlier conversation:\n${summary}` };
}
