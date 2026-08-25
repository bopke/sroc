import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";
import { db, getCurrentSystemPrompt, insertSystemPrompt, listSystemPrompts } from "../db.js";

const MAX_HISTORY = 20;
const DEFAULT_HISTORY_COUNT = 5;
const PREVIEW_LENGTH = 300;

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

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
      const current = getCurrentSystemPrompt(db);
      await interaction.reply({
        content: current ? current.content : "No system prompt is currently set.",
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "set") {
      const text = interaction.options.getString("text", true);
      const previous = getCurrentSystemPrompt(db);
      insertSystemPrompt(db, text, interaction.user.id, interaction.user.tag);

      await interaction.reply(
        `**System prompt updated by ${interaction.user.tag}**\n` +
          `Previous: ${previous ? truncate(previous.content, PREVIEW_LENGTH) : "*none*"}\n` +
          `New: ${truncate(text, PREVIEW_LENGTH)}\n` +
          `-# This only affects conversations started from now on.`,
      );
      return;
    }

    if (subcommand === "history") {
      const count = interaction.options.getInteger("count") ?? DEFAULT_HISTORY_COUNT;
      const entries = listSystemPrompts(db, count);

      if (entries.length === 0) {
        await interaction.reply({ content: "No system prompt changes recorded yet.", ephemeral: true });
        return;
      }

      const lines = entries.map((entry) => {
        const date = new Date(entry.created_at).toISOString();
        return `**${date}** by ${entry.changed_by_tag}\n${truncate(entry.content, PREVIEW_LENGTH)}`;
      });

      await interaction.reply({ content: lines.join("\n\n"), ephemeral: true });
    }
  },
};
