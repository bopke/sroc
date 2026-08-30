import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";

const body = commands.map((command) => command.data.toJSON());

const rest = new REST().setToken(config.token);

async function main() {
  const guildRoute = Routes.applicationGuildCommands(config.clientId, config.guildId);
  console.log(`Deploying ${body.length} command(s) to guild ${config.guildId}...`);
  await rest.put(guildRoute, { body });
  console.log("Successfully deployed guild commands.");

  const globalRoute = Routes.applicationCommands(config.clientId);
  console.log(`Deploying ${body.length} global command(s) for DMs...`);
  await rest.put(globalRoute, { body });
  console.log("Successfully deployed global commands.");
}

main().catch((error) => {
  console.error("Failed to deploy commands:", error);
  process.exit(1);
});
