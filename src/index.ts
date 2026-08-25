import { Client, Collection, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";
import type { Command } from "./types.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commandsByName = new Collection<string, Command>();
for (const command of commands) {
  commandsByName.set(command.data.name, command);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    console.warn(`No handler for command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing command ${interaction.commandName}:`, error);
    const reply = { content: "There was an error executing this command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(config.token);
