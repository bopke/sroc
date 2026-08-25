import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";

export const ping: Command = {
  data: new SlashCommandBuilder().setName("ping").setDescription("Replies with pong and latency"),
  async execute(interaction) {
    const sent = await interaction.reply({ content: "Pinging...", withResponse: true });
    const latency = sent.resource!.message!.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`Pong! Latency: ${latency}ms`);
  },
  async runText(message) {
    const sent = await message.reply("Pinging...");
    const latency = sent.createdTimestamp - message.createdTimestamp;
    await sent.edit(`Pong! Latency: ${latency}ms`);
  },
};
