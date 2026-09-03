import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GithubAuthSource = "gh" | "env" | "none";

export interface GithubAuth {
  source(): GithubAuthSource;
  label(): string;
  hasAny(): boolean;
  getBearer(): Promise<string>;
}

/** Strip env tokens so `gh auth token` reads the host login, not a stale GITHUB_TOKEN. */
export function ghAuthEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, HOME: home };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

export function ghHostsPath(home: string): string {
  return join(home, ".config", "gh", "hosts.yml");
}

async function defaultReadGhToken(home: string, ghBin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(ghBin, ["auth", "token"], {
      env: ghAuthEnv(home),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function createGithubAuth(opts: {
  envToken?: string;
  home?: string;
  ghBin?: string;
  readGhToken?: () => Promise<string | undefined>;
}): GithubAuth {
  const home = opts.home ?? homedir();
  const ghBin = opts.ghBin ?? "gh";
  const readGhToken = opts.readGhToken ?? (() => defaultReadGhToken(home, ghBin));
  let cached: { token: string; mtimeMs: number } | null = null;
  let lastSource: GithubAuthSource = "none";

  function hasGhHosts(): boolean {
    return existsSync(ghHostsPath(home));
  }

  async function tokenFromGh(): Promise<string | undefined> {
    const hosts = ghHostsPath(home);
    if (existsSync(hosts)) {
      const mtimeMs = statSync(hosts).mtimeMs;
      if (cached && cached.mtimeMs === mtimeMs) return cached.token;
      const token = await readGhToken();
      if (!token) {
        cached = null;
        return undefined;
      }
      cached = { token, mtimeMs };
      return token;
    }
    cached = null;
    return await readGhToken();
  }

  return {
    source() {
      if (lastSource !== "none") return lastSource;
      if (hasGhHosts()) return "gh";
      if (opts.envToken) return "env";
      return "none";
    },
    label() {
      const src = this.source();
      if (src === "gh") return "gh auth (host)";
      if (src === "env") return "GITHUB_TOKEN";
      return "none";
    },
    hasAny() {
      return Boolean(opts.envToken) || hasGhHosts();
    },
    async getBearer() {
      const ghToken = await tokenFromGh();
      if (ghToken) {
        lastSource = "gh";
        return ghToken;
      }
      if (opts.envToken) {
        lastSource = "env";
        return opts.envToken;
      }
      lastSource = "none";
      throw new Error(
        "No GitHub credential. Run `gh auth login` on this host or set GITHUB_TOKEN.",
      );
    },
  };
}
