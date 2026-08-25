import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";
import { db, getCurrentSystemPrompt, insertSystemPrompt, listSystemPrompts } from "../db.js";

const MAX_HISTORY = 20;
const DEFAULT_HISTORY_COUNT = 5;
const PREVIEW_LENGTH = 300;

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatView(): string {
  const current = getCurrentSystemPrompt(db);
  return current ? current.content : "No system prompt is currently set.";
}

function formatSet(text: string, userId: string, userTag: string): string {
  const previous = getCurrentSystemPrompt(db);
  insertSystemPrompt(db, text, userId, userTag);
  return (
    `**System prompt updated by ${userTag}**\n` +
    `Previous: ${previous ? truncate(previous.content, PREVIEW_LENGTH) : "*none*"}\n` +
    `New: ${truncate(text, PREVIEW_LENGTH)}\n` +
    `-# This only affects conversations started from now on.`
  );
}

function formatHistory(count: number): string {
  const entries = listSystemPrompts(db, count);
  if (entries.length === 0) return "No system prompt changes recorded yet.";

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
            .setDescription(`How many entries to show (default ${DEFAULT_HISTORY_COUNT}, max ${MAX_HISTORY})`)
            .setMinValue(1)
            .setMaxValue(MAX_HISTORY),
        ),
    ),
  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "view") {
      await interaction.reply({ content: formatView(), ephemeral: true });
      return;
    }

    if (subcommand === "set") {
      const text = interaction.options.getString("text", true);
      await interaction.reply(formatSet(text, interaction.user.id, interaction.user.tag));
      return;
    }

    if (subcommand === "history") {
      const count = interaction.options.getInteger("count") ?? DEFAULT_HISTORY_COUNT;
      await interaction.reply({ content: formatHistory(count), ephemeral: true });
    }
  },
  async runText(message, args) {
    const [subcommand, ...rest] = args;

    if (subcommand === "view") {
      await message.reply(formatView());
      return;
    }

    if (subcommand === "set") {
      const text = rest.join(" ").trim();
      if (!text) {
        await message.reply("Usage: `$systemprompt set <text>`");
        return;
      }
      await message.reply(formatSet(text, message.author.id, message.author.tag));
      return;
    }

    if (subcommand === "history") {
      await message.reply(formatHistory(clampHistoryCount(rest[0])));
      return;
    }

    await message.reply(TEXT_USAGE);
  },
};
