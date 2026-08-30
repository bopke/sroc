import { getLatestAssistantInChannel, getMessage, type DB } from "./db.js";

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

export function isAllowedSource(input: {
  guildId: string | null | undefined;
  authorId: string;
  configuredGuildId: string;
  ownerId: string;
}): boolean {
  if (input.guildId) return input.guildId === input.configuredGuildId;
  return input.authorId === input.ownerId;
}

export interface ChatTarget {
  parentMessageId: string | null;
  resumeSessionId: string | null;
}

/**
 * Guild: reply to a tracked assistant continues; @mention starts new; else ignore.
 * Owner DM: reply continues that branch; @mention starts new; other messages
 * continue the latest assistant in that DM (or start new if none).
 */
export function resolveChatTarget(
  db: DB,
  input: {
    repliedToId: string | undefined;
    mentionedBot: boolean;
    isDm: boolean;
    channelId: string;
  },
): ChatTarget | null {
  if (input.repliedToId && isTrackedAssistantMessage(db, input.repliedToId)) {
    return {
      parentMessageId: input.repliedToId,
      resumeSessionId: getResumeSessionId(db, input.repliedToId),
    };
  }
  if (input.mentionedBot) {
    return { parentMessageId: null, resumeSessionId: null };
  }
  if (!input.isDm) return null;

  const last = getLatestAssistantInChannel(db, input.channelId);
  if (last) {
    return { parentMessageId: last.message_id, resumeSessionId: last.grok_session_id };
  }
  return { parentMessageId: null, resumeSessionId: null };
}

export function buildSessionRules(
  systemPrompt: string | null,
  channelName: string | undefined,
  options: { dm?: boolean; repoUrl?: string; githubConfigured?: boolean } = {},
): string {
  const location = options.dm
    ? "You are chatting in a Discord DM with the bot owner."
    : `You are a Discord bot replying in the #${channelName ?? "unknown"} channel.`;
  const parts = [
    location,
    "Reply to greetings and simple questions immediately. Do not explore the filesystem or run tools unless the user asks you to work on files, commands, or a pull request.",
    "The workspace starts empty and is isolated from the host.",
  ];
  if (options.githubConfigured) {
    parts.push(
      "git and gh talk to GitHub through a host proxy; there is no GitHub token in this container. Clone with git/gh repo clone, push as usual, and open a PR with `gh pr create`. Never force-push protected branches.",
    );
  } else {
    parts.push("No GitHub token is configured; you cannot push or open pull requests.");
  }
  if (options.repoUrl) {
    parts.push(
      `This bot's own repo is ${options.repoUrl}. If the user asks you to change it or open a PR, clone that URL (or the repo they name) into the workspace first.`,
    );
  }
  parts.push(
    "Write Discord-friendly replies: concise unless the task needs detail or a code change.",
  );
  if (systemPrompt) parts.push(systemPrompt);
  return parts.join("\n\n");
}
