import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";
import { replyInteractionSplit, replyMessageSplit } from "../discordReply.js";
import {
  db,
  getCurrentSystemPrompt,
  insertSystemPrompt,
  listSystemPrompts,
  promptScope,
  type PromptScope,
} from "../db.js";

const MAX_HISTORY = 20;
const DEFAULT_HISTORY_COUNT = 5;
const PREVIEW_LENGTH = 300;

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function scopeLabel(scope: PromptScope): string {
  return scope === "dm" ? "DM" : "guild";
}

function formatView(scope: PromptScope): string {
  const current = getCurrentSystemPrompt(db, scope);
  if (!current) return `No ${scopeLabel(scope)} system prompt is currently set.`;
  return current.content;
}

function formatSet(text: string, userId: string, userTag: string, scope: PromptScope): string {
  const previous = getCurrentSystemPrompt(db, scope);
  insertSystemPrompt(db, text, userId, userTag, scope);
  return (
    `**${scopeLabel(scope)} system prompt updated by ${userTag}**\n` +
    `Previous: ${previous ? truncate(previous.content, PREVIEW_LENGTH) : "*none*"}\n` +
    `New: ${truncate(text, PREVIEW_LENGTH)}\n` +
    `-# This only affects conversations started from now on.`
  );
}

function formatHistory(count: number, scope: PromptScope): string {
  const entries = listSystemPrompts(db, count, scope);
  if (entries.length === 0) {
    return `No ${scopeLabel(scope)} system prompt changes recorded yet.`;
  }

  return entries
    .map((entry) => {
      const date = new Date(entry.created_at).toISOString();
      return `**${date}** by ${entry.changed_by_tag}\n${truncate(entry.content, PREVIEW_LENGTH)}`;
    })
    .join("\n\n");
}

function clampHistoryCount(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_HISTORY_COUNT;
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_COUNT;
  return Math.min(Math.max(parsed, 1), MAX_HISTORY);
}

const TEXT_USAGE = "Usage: `$systemprompt <view|set <text>|history [count]>`";

export const systemprompt: Command = {
  data: new SlashCommandBuilder()
    .setName("systemprompt")
    .setDescription("View or change the bot's system prompt")
    .addSubcommand((sub) => sub.setName("view").setDescription("Show the current system prompt"))
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Change the system prompt (affects new conversations only)")
        .addStringOption((opt) =>
          opt.setName("text").setDescription("The new system prompt").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("history")
        .setDescription("List recent system prompt changes")
        .addIntegerOption((opt) =>
          opt
            .setName("count")
            .setDescription(
              `How many entries to show (default ${DEFAULT_HISTORY_COUNT}, max ${MAX_HISTORY})`,
            )
            .setMinValue(1)
            .setMaxValue(MAX_HISTORY),
        ),
    ),
  async execute(interaction) {
    const scope = promptScope(interaction.guildId);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "view") {
      await replyInteractionSplit(interaction, formatView(scope), { ephemeral: true });
      return;
    }

    if (subcommand === "set") {
      const text = interaction.options.getString("text", true);
      await replyInteractionSplit(
        interaction,
        formatSet(text, interaction.user.id, interaction.user.tag, scope),
      );
      return;
    }

    if (subcommand === "history") {
      const count = interaction.options.getInteger("count") ?? DEFAULT_HISTORY_COUNT;
      await replyInteractionSplit(interaction, formatHistory(count, scope), { ephemeral: true });
    }
  },
  async runText(message, args) {
    const scope = promptScope(message.guildId);
    const [subcommand, ...rest] = args;

    if (subcommand === "view") {
      await replyMessageSplit(message, formatView(scope));
      return;
    }

    if (subcommand === "set") {
      const text = rest.join(" ").trim();
      if (!text) {
        await replyMessageSplit(message, "Usage: `$systemprompt set <text>`");
        return;
      }
      await replyMessageSplit(
        message,
        formatSet(text, message.author.id, message.author.tag, scope),
      );
      return;
    }

    if (subcommand === "history") {
      await replyMessageSplit(message, formatHistory(clampHistoryCount(rest[0]), scope));
      return;
    }

    await replyMessageSplit(message, TEXT_USAGE);
  },
};
