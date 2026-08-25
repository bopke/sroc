import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";

const body = commands.map((command) => command.data.toJSON());

const rest = new REST().setToken(config.token);

async function main() {
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  console.log(`Deploying ${body.length} command(s)${config.guildId ? " to guild" : " globally"}...`);
  await rest.put(route, { body });
  console.log("Successfully deployed commands.");
}

main().catch((error) => {
  console.error("Failed to deploy commands:", error);
  process.exit(1);
});
