import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function requireGrokApiKey(): string {
  const key = optionalEnv("XAI_API_KEY") ?? optionalEnv("GROK_API_KEY");
  if (!key) {
    throw new Error("Missing required environment variable: XAI_API_KEY (or GROK_API_KEY)");
  }
  return key;
}

function defaultWorkspace(): string {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const workspace = join(projectRoot, "workspace");
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

export const config = {
  token: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("DISCORD_CLIENT_ID"),
  guildId: requireEnv("DISCORD_GUILD_ID"),
  ownerId: requireEnv("OWNER_ID"),
  grokApiKey: requireGrokApiKey(),
  grokModel: process.env.GROK_MODEL ?? "grok-build",
  grokBin: process.env.GROK_BIN ?? "grok",
  grokCwd: optionalEnv("GROK_CWD") ?? defaultWorkspace(),
  grokAlwaysApprove: boolEnv("GROK_ALWAYS_APPROVE", true),
  grokSandbox: optionalEnv("GROK_SANDBOX") ?? "workspace",
  grokTimeoutMs: Number.parseInt(process.env.GROK_TIMEOUT_MS ?? "600000", 10) || 600000,
};
