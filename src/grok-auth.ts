import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GrokAuthSource = "session" | "api_key";

interface GrokSession {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
}

type AuthFile = Record<string, GrokSession>;

export interface GrokAuth {
  source(): GrokAuthSource | "none";
  label(): string;
  hasAny(): boolean;
  getBearer(): Promise<string>;
}

const REFRESH_SKEW_MS = 120_000;
const DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";

function tokenUrlFor(session: GrokSession, override?: string): string {
  if (override) return override;
  const issuer = session.oidc_issuer?.replace(/\/$/, "");
  return issuer ? `${issuer}/oauth2/token` : DEFAULT_TOKEN_URL;
}

function isFresh(session: GrokSession, now: number): boolean {
  if (!session.key) return false;
  if (!session.expires_at) return true;
  const expires = Date.parse(session.expires_at);
  if (Number.isNaN(expires)) return true;
  return expires - REFRESH_SKEW_MS > now;
}

function pickSession(data: AuthFile): { id: string; session: GrokSession } | undefined {
  for (const [id, session] of Object.entries(data)) {
    if (session && (session.key || session.refresh_token)) return { id, session };
  }
  return undefined;
}

function readAuthFile(path: string): AuthFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AuthFile;
    }
  } catch {
    // missing or unreadable
  }
  return {};
}

function writeAuthFile(path: string, data: AuthFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function createGrokAuth(opts: {
  grokHome: string;
  apiKey?: string;
  tokenUrl?: string;
  now?: () => number;
}): GrokAuth {
  const authPath = join(opts.grokHome, "auth.json");
  const now = opts.now ?? Date.now;
  let refreshLock: Promise<void> | null = null;

  function snapshot(): { id: string; session: GrokSession; data: AuthFile } | undefined {
    const data = readAuthFile(authPath);
    const picked = pickSession(data);
    if (!picked) return undefined;
    return { ...picked, data };
  }

  async function refresh(picked: {
    id: string;
    session: GrokSession;
    data: AuthFile;
  }): Promise<void> {
    const refreshToken = picked.session.refresh_token;
    const clientId = picked.session.oidc_client_id;
    if (!refreshToken || !clientId) {
      throw new Error("grok login session is missing refresh_token or oidc_client_id");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const response = await fetch(tokenUrlFor(picked.session, opts.tokenUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`grok login refresh failed (${response.status})`);
    }
    const payload = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) {
      throw new Error("grok login refresh returned no access_token");
    }
    const expiresAt = new Date(now() + (payload.expires_in ?? 3600) * 1000).toISOString();
    picked.data[picked.id] = {
      ...picked.session,
      key: payload.access_token,
      refresh_token: payload.refresh_token ?? refreshToken,
      expires_at: expiresAt,
    };
    writeAuthFile(authPath, picked.data);
  }

  async function ensureSession(): Promise<string | undefined> {
    const picked = snapshot();
    if (!picked) return undefined;
    if (isFresh(picked.session, now())) return picked.session.key;
    if (!picked.session.refresh_token) return picked.session.key;
    if (!refreshLock) {
      refreshLock = refresh(picked).finally(() => {
        refreshLock = null;
      });
    }
    await refreshLock;
    return snapshot()?.session.key;
  }

  return {
    source() {
      if (snapshot()) return "session";
      if (opts.apiKey) return "api_key";
      return "none";
    },
    label() {
      const src = this.source();
      if (src === "session") return "grok login (SuperGrok)";
      if (src === "api_key") return "XAI_API_KEY";
      return "none";
    },
    hasAny() {
      return this.source() !== "none";
    },
    async getBearer() {
      try {
        const sessionKey = await ensureSession();
        if (sessionKey) return sessionKey;
      } catch (error) {
        if (!opts.apiKey) throw error;
      }
      if (opts.apiKey) return opts.apiKey;
      throw new Error(
        "No Grok credential. Run `grok login` on this host (SuperGrok) or set XAI_API_KEY.",
      );
    },
  };
}
