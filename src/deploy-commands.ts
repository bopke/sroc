import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";

const body = commands.map((command) => command.data.toJSON());

const rest = new REST().setToken(config.token);

async function main() {
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);

  console.log(`Deploying ${body.length} command(s) to guild ${config.guildId}...`);
  await rest.put(route, { body });
  console.log("Successfully deployed commands.");
}

main().catch((error) => {
  console.error("Failed to deploy commands:", error);
  process.exit(1);
});
