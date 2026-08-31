import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types.js";
import { db, setDeployNotice } from "../db.js";

const execFileAsync = promisify(execFile);
const STEP_TIMEOUT_MS = 120_000;
const RESTART_DELAY_MS = 1_000;
const STEP_LOG_LIMIT = 400;
export const DISCORD_REPLY_LIMIT = 2000;

export function botRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function clipLog(text: string, max = STEP_LOG_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…${trimmed.slice(-(max - 1))}`;
}

export function clipDiscordReply(text: string): string {
  return clipLog(text, DISCORD_REPLY_LIMIT);
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

export function formatDeployReply(opts: {
  pull: string;
  build: string;
  image?: string;
  imageError?: string;
  deployCmds?: string;
  deployCmdsError?: string;
}): string {
  const lines = [
    "**git pull**",
    clipLog(opts.pull) || "already up to date",
    "",
    "**npm run build**",
    clipLog(opts.build) || "ok",
  ];
  if (opts.imageError) {
    lines.push("", "**build-image** (failed, restarting anyway)", clipLog(opts.imageError));
  } else {
    lines.push("", "**build-image**", clipLog(opts.image ?? "") || "ok");
  }
  if (opts.deployCmdsError) {
    lines.push(
      "",
      "**deploy-commands** (failed, restarting anyway)",
      clipLog(opts.deployCmdsError),
    );
  } else {
    lines.push("", "**deploy-commands**", clipLog(opts.deployCmds ?? "") || "ok");
  }
  lines.push("", "Restarting.");
  return clipDiscordReply(lines.join("\n"));
}

export async function pullAndBuild(): Promise<string> {
  const cwd = botRoot();
  const pull = await run("git", ["pull", "--ff-only"], cwd);
  const build = await run("npm", ["run", "build"], cwd);
  const parts: Parameters<typeof formatDeployReply>[0] = { pull, build };

  try {
    parts.image = await run("npm", ["run", "build-image"], cwd);
  } catch (error) {
    parts.imageError = error instanceof Error ? error.message : String(error);
  }

  try {
    parts.deployCmds = await run("npm", ["run", "deploy-commands"], cwd);
  } catch (error) {
    parts.deployCmdsError = error instanceof Error ? error.message : String(error);
  }

  return formatDeployReply(parts);
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
    let summary: string;
    try {
      summary = await pullAndBuild();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.editReply(clipDiscordReply(`Deploy failed.\n${message}`));
      return;
    }
    try {
      await interaction.editReply(summary);
      const reply = await interaction.fetchReply();
      setDeployNotice(db, reply.channelId, reply.id);
    } catch (error) {
      console.error("deploy: could not post summary", error);
    }
    scheduleRestart();
  },
  async runText(message) {
    const status = await message.reply("-# Deploying...");
    let summary: string;
    try {
      summary = await pullAndBuild();
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      await status.edit(clipDiscordReply(`Deploy failed.\n${errMessage}`));
      return;
    }
    try {
      await status.edit(summary);
      setDeployNotice(db, status.channelId, status.id);
    } catch (error) {
      console.error("deploy: could not post summary", error);
    }
    scheduleRestart();
  },
};
