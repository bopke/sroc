import { execFile, spawn } from "node:child_process";
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
  gitUserName: string;
  gitUserEmail: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  cloneRepo: boolean;
  xaiProxyUrl: string;
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
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/tmp:mode=1777,exec",
    settings.image,
    "sleep",
    "infinity",
  ];
}

export const CONTAINER_XAI_PLACEHOLDER = "sroc-local";

export function containerGrokConfig(xaiProxyUrl: string): string {
  return [
    "[cli]",
    "auto_update = false",
    "",
    "[endpoints]",
    `xai_api_base_url = ${JSON.stringify(xaiProxyUrl)}`,
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    "ignore_default_excludes = false",
    'include_only = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]',
    "",
  ].join("\n");
}

export function dockerExecGrokArgs(
  containerName: string,
  grokArgs: string[],
  xaiProxyUrl: string,
): string[] {
  return [
    "exec",
    "-e",
    `XAI_API_KEY=${CONTAINER_XAI_PLACEHOLDER}`,
    "-e",
    `GROK_XAI_API_BASE_URL=${xaiProxyUrl}`,
    "-e",
    "GIT_TERMINAL_PROMPT=0",
    "-e",
    "GH_PROMPT_DISABLED=1",
    "-e",
    "GIT_AUTHOR_NAME",
    "-e",
    "GIT_AUTHOR_EMAIL",
    "-e",
    "GIT_COMMITTER_NAME",
    "-e",
    "GIT_COMMITTER_EMAIL",
    "-e",
    "GROK_DISABLE_AUTOUPDATER=1",
    "-e",
    `HOME=${INNER_HOME}`,
    containerName,
    "grok",
    ...grokArgs,
  ];
}

export function gitConfigCommands(name: string, email: string): string[][] {
  return [
    ["git", "config", "--global", "user.name", name],
    ["git", "config", "--global", "user.email", email],
    ["git", "config", "--global", "init.defaultBranch", "main"],
    ["git", "config", "--global", "--add", "safe.directory", "*"],
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

function dockerClientEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

async function execIn(
  containerName: string,
  argv: string[],
): Promise<{ stdout: string; stderr: string }> {
  return docker(
    [
      "exec",
      "-e",
      "GIT_TERMINAL_PROMPT=0",
      "-e",
      "GH_PROMPT_DISABLED=1",
      "-e",
      `HOME=${INNER_HOME}`,
      containerName,
      ...argv,
    ],
    { env: dockerClientEnv() },
  );
}

function execWithStdin(containerName: string, argv: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-e",
        "GIT_TERMINAL_PROMPT=0",
        "-e",
        "GH_PROMPT_DISABLED=1",
        "-e",
        `HOME=${INNER_HOME}`,
        containerName,
        ...argv,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: dockerClientEnv() },
    );
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          Buffer.concat(stderrChunks).toString("utf8").trim() || `docker exec exited ${code}`,
        ),
      );
    });
    child.stdin?.end(input);
  });
}

async function provision(containerName: string, settings: IsolateSettings): Promise<void> {
  const { stdout: ready } = await execIn(containerName, [
    "sh",
    "-c",
    "test -f /home/node/.sroc-provisioned && echo yes || echo no",
  ]);

  if (ready !== "yes") {
    for (const cmd of gitConfigCommands(settings.gitUserName, settings.gitUserEmail)) {
      await execIn(containerName, cmd);
    }
    await execWithStdin(
      containerName,
      ["sh", "-c", "mkdir -p /home/node/.grok && cat > /home/node/.grok/config.toml"],
      containerGrokConfig(settings.xaiProxyUrl),
    );
    if (settings.githubToken) {
      await execWithStdin(
        containerName,
        ["gh", "auth", "login", "--hostname", "github.com", "--with-token"],
        `${settings.githubToken}\n`,
      );
      await execIn(containerName, ["gh", "auth", "setup-git"]);
    }
    await execIn(containerName, ["sh", "-c", "touch /home/node/.sroc-provisioned"]);
  }

  if (!settings.cloneRepo) return;

  const { stdout: hasGit } = await execIn(containerName, [
    "sh",
    "-c",
    "test -d /workspace/.git && echo yes || echo no",
  ]);
  if (hasGit === "yes") return;

  // Clone without embedding the token in argv; gh/git credentials are already on disk.
  await execIn(containerName, [
    "sh",
    "-c",
    'git clone --depth 1 "$1" /tmp/repo && find /tmp/repo -mindepth 1 -maxdepth 1 -exec mv {} /workspace/ \\; && rm -rf /tmp/repo',
    "sh",
    settings.repoUrl,
  ]);
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
