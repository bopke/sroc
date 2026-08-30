import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  dockerExecGrokArgs,
  ensureWorkspace,
  INNER_CWD,
  workspaceContainerName,
  type IsolateSettings,
} from "./isolate.js";

export interface GrokBuildSettings {
  bin: string;
  model: string;
  cwd: string;
  apiKey: string;
  githubToken?: string;
  alwaysApprove: boolean;
  sandbox: string;
  timeoutMs: number;
  isolate: boolean;
  isolateSettings: IsolateSettings;
}

export interface GrokResult {
  text: string;
  sessionId: string;
}

export type GrokStreamEvent =
  | { type: "text"; data: string }
  | { type: "tool_call"; title?: string; toolName?: string }
  | { type: "end"; sessionId: string }
  | { type: "result"; text: string; sessionId: string }
  | { type: "error"; message: string };

export interface CollectedResult {
  text: string;
  sessionId: string | null;
  error: string | null;
}

export interface BuildGrokArgsInput {
  prompt: string;
  model?: string | null;
  cwd: string;
  resumeSessionId?: string;
  fork?: boolean;
  rules?: string | null;
  alwaysApprove: boolean;
  sandbox?: string | null;
}

/** Omit `-m` so Grok Build uses its configured default model. */
export function usesCliDefaultModel(model: string | null | undefined): boolean {
  if (model == null) return true;
  const trimmed = model.trim();
  return trimmed === "" || trimmed.toLowerCase() === "default";
}

export function buildGrokArgs(opts: BuildGrokArgsInput): string[] {
  const args = ["-p", opts.prompt];
  const model = opts.model?.trim() ?? "";
  if (!usesCliDefaultModel(model)) {
    args.push("-m", model);
  }
  args.push("--cwd", opts.cwd, "--output-format", "streaming-json", "--verbatim");

  if (opts.alwaysApprove) args.push("--always-approve");
  if (opts.sandbox && opts.sandbox !== "off") args.push("--sandbox", opts.sandbox);

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
    if (opts.fork) args.push("--fork-session");
  }

  if (opts.rules) args.push("--rules", opts.rules);

  return args;
}

export function emptyCollection(): CollectedResult {
  return { text: "", sessionId: null, error: null };
}

export function parseStreamLine(line: string): GrokStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;

  // Headless `--output-format json` is a single untyped object.
  if (!obj.type && typeof obj.sessionId === "string") {
    return {
      type: "result",
      text: typeof obj.text === "string" ? obj.text : "",
      sessionId: obj.sessionId,
    };
  }

  switch (obj.type) {
    case "text":
      return { type: "text", data: String(obj.data ?? "") };
    case "tool_call":
      return {
        type: "tool_call",
        title: typeof obj.title === "string" ? obj.title : undefined,
        toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
      };
    case "end":
      return { type: "end", sessionId: String(obj.sessionId ?? "") };
    case "error":
      return { type: "error", message: String(obj.message ?? "Grok error") };
    default:
      return null;
  }
}

export function applyStreamEvent(state: CollectedResult, event: GrokStreamEvent): void {
  switch (event.type) {
    case "text":
      state.text += event.data;
      break;
    case "end":
      if (event.sessionId) state.sessionId = event.sessionId;
      break;
    case "result":
      if (!state.text) state.text = event.text;
      state.sessionId = event.sessionId;
      break;
    case "error":
      state.error = event.message;
      break;
    default:
      break;
  }
}

export function reduceStdout(stdout: string): CollectedResult {
  const state = emptyCollection();
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseStreamLine(line);
    if (event) applyStreamEvent(state, event);
  }
  return state;
}

function readLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buf.length > 0) onLine(buf);
      resolve();
    });
    stream.on("error", reject);
  });
}

export interface RunGrokInput {
  prompt: string;
  resumeSessionId?: string | null;
  fork?: boolean;
  rules?: string | null;
  workspaceId?: string | null;
  onEvent?: (event: GrokStreamEvent) => void;
}

export class GrokBuildClient {
  constructor(private readonly settings: GrokBuildSettings) {}

  async prompt(input: RunGrokInput): Promise<GrokResult> {
    const isolated = this.settings.isolate;
    if (isolated && !input.workspaceId) {
      throw new Error("Isolated Grok runs require a workspace id");
    }

    if (isolated && input.workspaceId) {
      await ensureWorkspace(input.workspaceId, this.settings.isolateSettings);
    }

    const args = buildGrokArgs({
      prompt: input.prompt,
      model: this.settings.model,
      cwd: isolated ? INNER_CWD : this.settings.cwd,
      resumeSessionId: input.resumeSessionId ?? undefined,
      fork: input.fork,
      rules: input.rules,
      alwaysApprove: this.settings.alwaysApprove,
      sandbox: isolated ? "off" : this.settings.sandbox,
    });

    const env = {
      ...process.env,
      XAI_API_KEY: this.settings.apiKey,
      GH_TOKEN: this.settings.githubToken ?? "",
      GITHUB_TOKEN: this.settings.githubToken ?? "",
      GROK_DISABLE_AUTOUPDATER: "1",
    };

    const child = isolated
      ? spawn("docker", dockerExecGrokArgs(workspaceContainerName(input.workspaceId!), args), {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(this.settings.bin, args, {
          cwd: this.settings.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

    const collected = emptyCollection();
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const stdoutDone = child.stdout
      ? readLines(child.stdout, (line) => {
          const event = parseStreamLine(line);
          if (!event) return;
          applyStreamEvent(collected, event);
          input.onEvent?.(event);
        })
      : Promise.resolve();

    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          if (isolated && input.workspaceId) {
            spawn(
              "docker",
              ["exec", workspaceContainerName(input.workspaceId), "pkill", "-TERM", "grok"],
              {
                stdio: "ignore",
              },
            );
          }
          reject(new Error(`Grok timed out after ${this.settings.timeoutMs}ms`));
        }, this.settings.timeoutMs);

        child.on("error", (error) => {
          clearTimeout(timer);
          reject(wrapSpawnError(error, isolated ? "docker" : this.settings.bin));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      await stdoutDone;
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }

    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

    if (collected.error) {
      throw new Error(collected.error);
    }
    if (exitCode !== 0) {
      throw new Error(stderr || `Grok exited with code ${exitCode}`);
    }
    if (!collected.text) {
      throw new Error("Grok returned an empty response");
    }
    if (!collected.sessionId) {
      throw new Error("Grok did not return a session id");
    }

    return { text: collected.text, sessionId: collected.sessionId };
  }
}

function wrapSpawnError(error: unknown, bin: string): Error {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    if (bin === "docker") {
      return new Error("Docker not found. Install docker and build the sroc-agent image.");
    }
    return new Error(
      `Grok CLI not found (${bin}). Install it from https://x.ai/cli/install.sh or set GROK_BIN.`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
