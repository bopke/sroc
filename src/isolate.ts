import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKSPACE_LABEL = "sroc.workspace";
export const CONTAINER_PREFIX = "sroc-ws-";
const INNER_CWD = "/workspace";
const INNER_HOME = "/home/node";

export interface IsolateSettings {
  image: string;
  repoUrl: string;
  githubToken?: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  cloneRepo: boolean;
}

export function workspaceContainerName(workspaceId: string): string {
  return `${CONTAINER_PREFIX}${workspaceId}`;
}

export function cloneUrlWithToken(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = "x-access-token";
    url.password = token;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

export function dockerRunArgs(containerName: string, settings: IsolateSettings): string[] {
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${WORKSPACE_LABEL}=1`,
    "--memory",
    settings.memory,
    "--cpus",
    settings.cpus,
    "--pids-limit",
    String(settings.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "bridge",
    "--tmpfs",
    "/tmp:mode=1777,exec",
    settings.image,
    "sleep",
    "infinity",
  ];
}

export function dockerExecGrokArgs(containerName: string, grokArgs: string[]): string[] {
  return [
    "exec",
    "-e",
    "XAI_API_KEY",
    "-e",
    "GH_TOKEN",
    "-e",
    "GITHUB_TOKEN",
    "-e",
    "GROK_DISABLE_AUTOUPDATER=1",
    "-e",
    `HOME=${INNER_HOME}`,
    containerName,
    "grok",
    ...grokArgs,
  ];
}

async function docker(args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: opts.env ?? process.env,
    });
    return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim() };
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message: string };
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n").trim();
    throw new Error(detail || err.message);
  }
}

async function inspectRunning(name: string): Promise<"running" | "stopped" | "missing"> {
  try {
    const { stdout } = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    return stdout === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

async function provision(containerName: string, settings: IsolateSettings): Promise<void> {
  if (!settings.cloneRepo) return;

  const { stdout: hasGit } = await docker([
    "exec",
    containerName,
    "sh",
    "-c",
    "test -d /workspace/.git && echo yes || echo no",
  ]);
  if (hasGit === "yes") return;

  const cloneUrl = cloneUrlWithToken(settings.repoUrl, settings.githubToken);
  // Clone into a temp dir then move, because /workspace may already exist (WORKDIR).
  await docker([
    "exec",
    "-e",
    "GIT_TERMINAL_PROMPT=0",
    containerName,
    "sh",
    "-c",
    'git clone --depth 1 "$1" /tmp/repo && find /tmp/repo -mindepth 1 -maxdepth 1 -exec mv {} /workspace/ \\; && rm -rf /tmp/repo',
    "sh",
    cloneUrl,
  ]);

  const origin = settings.repoUrl;
  await docker(["exec", containerName, "git", "remote", "set-url", "origin", origin]);
  await docker([
    "exec",
    containerName,
    "git",
    "config",
    "user.email",
    "sroc-bot@users.noreply.github.com",
  ]);
  await docker(["exec", containerName, "git", "config", "user.name", "sroc bot"]);
}

export async function ensureWorkspace(
  workspaceId: string,
  settings: IsolateSettings,
): Promise<string> {
  const name = workspaceContainerName(workspaceId);
  const state = await inspectRunning(name);
  if (state === "missing") {
    await docker(dockerRunArgs(name, settings));
  } else if (state === "stopped") {
    await docker(["start", name]);
  }
  await provision(name, settings);
  return name;
}

export async function pruneWorkspaces(): Promise<string> {
  const { stdout } = await docker(["ps", "-aq", "--filter", `label=${WORKSPACE_LABEL}=1`]);
  const ids = stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return "No conversation containers to remove.";
  await docker(["rm", "-f", ...ids]);
  return `Removed ${ids.length} conversation container(s).`;
}

export async function listWorkspaces(): Promise<string> {
  const { stdout } = await docker([
    "ps",
    "-a",
    "--filter",
    `label=${WORKSPACE_LABEL}=1`,
    "--format",
    "{{.Names}}\t{{.Status}}",
  ]);
  return stdout || "No conversation containers.";
}

export { INNER_CWD };
