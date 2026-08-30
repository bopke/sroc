import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";

const execFileAsync = promisify(execFile);
const STEP_TIMEOUT_MS = 120_000;
const RESTART_DELAY_MS = 1_000;
const LOG_LIMIT = 1200;

export function botRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function clipLog(text: string, max = LOG_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(-(max - 1))}`;
}

/** systemd system units often omit HOME, which hides ~/.gitconfig and gh auth. */
export function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homedir(),
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function run(bin: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: STEP_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: commandEnv(),
    });
    return [stdout, stderr]
      .filter((part) => part && part.trim())
      .join("\n")
      .trim();
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const detail = [err.stderr, err.stdout, err.message]
      .filter((part) => part && part.trim())
      .join("\n");
    throw new Error(clipLog(detail || err.message));
  }
}

export async function pullAndBuild(): Promise<string> {
  const cwd = botRoot();
  const pull = await run("git", ["pull", "--ff-only"], cwd);
  const build = await run("npm", ["run", "build"], cwd);
  const lines = [
    "**git pull**",
    clipLog(pull) || "already up to date",
    "",
    "**npm run build**",
    clipLog(build) || "ok",
  ];

  try {
    const image = await run("npm", ["run", "build-image"], cwd);
    lines.push("", "**build-image**", clipLog(image) || "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push("", "**build-image** (failed, restarting anyway)", clipLog(message));
  }

  try {
    const deployCmds = await run("npm", ["run", "deploy-commands"], cwd);
    lines.push("", "**deploy-commands**", clipLog(deployCmds) || "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push("", "**deploy-commands** (failed, restarting anyway)", clipLog(message));
  }

  lines.push("", "Restarting.");
  return lines.join("\n");
}

function scheduleRestart(): void {
  setTimeout(() => {
    process.exit(0);
  }, RESTART_DELAY_MS);
}

export const deploy: Command = {
  data: new SlashCommandBuilder()
    .setName("deploy")
    .setDescription("Pull latest code, rebuild, and restart the bot"),
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const summary = await pullAndBuild();
      await interaction.editReply(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Deploy failed.\n${clipLog(message)}`);
      return;
    }
    scheduleRestart();
  },
  async runText(message) {
    const status = await message.reply("-# Deploying...");
    try {
      const summary = await pullAndBuild();
      await status.edit(summary);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      await status.edit(`Deploy failed.\n${clipLog(errMessage)}`);
      return;
    }
    scheduleRestart();
  },
};
