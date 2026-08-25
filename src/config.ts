import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  token: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("DISCORD_CLIENT_ID"),
  guildId: requireEnv("DISCORD_GUILD_ID"),
  grokApiKey: requireEnv("GROK_API_KEY"),
  grokModel: process.env.GROK_MODEL ?? "grok-3",
};
