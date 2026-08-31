import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";
import { config } from "../config.js";
import { replyInteractionSplit, replyMessageSplit } from "../discordReply.js";
import { listWorkspaces, pruneWorkspaces } from "../isolate.js";

function isOwner(userId: string): boolean {
  return userId === config.ownerId;
}

export const isolate: Command = {
  data: new SlashCommandBuilder()
    .setName("isolate")
    .setDescription("List or destroy per-conversation containers")
    .addSubcommand((sub) => sub.setName("status").setDescription("List conversation containers"))
    .addSubcommand((sub) =>
      sub.setName("prune").setDescription("Remove all conversation containers"),
    ),
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) {
      await replyInteractionSplit(interaction, "Only the owner can manage isolation.", {
        ephemeral: true,
      });
      return;
    }
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = sub === "prune" ? await pruneWorkspaces() : await listWorkspaces();
      await replyInteractionSplit(interaction, result, { ephemeral: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replyInteractionSplit(interaction, `Isolate failed.\n${message}`, { ephemeral: true });
    }
  },
  async runText(message, args) {
    if (!isOwner(message.author.id)) {
      await replyMessageSplit(message, "Only the owner can manage isolation.");
      return;
    }
    const sub = args[0] ?? "status";
    try {
      if (sub === "prune") {
        await replyMessageSplit(message, await pruneWorkspaces());
        return;
      }
      if (sub === "status") {
        await replyMessageSplit(message, await listWorkspaces());
        return;
      }
      await replyMessageSplit(message, "Usage: `$isolate <status|prune>`");
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      await replyMessageSplit(message, `Isolate failed.\n${errMessage}`);
    }
  },
};
