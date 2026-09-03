import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const GITHUB_HOSTS = new Set(["github.com", "api.github.com"]);

/** An upstream response kept aside while an anonymous retry is attempted. */
interface HeldResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer | null;
}

export function dockerBridgeAddress(): string {
  const nic = networkInterfaces().docker0;
  const ipv4 = nic?.find((entry) => entry.family === "IPv4" && !entry.internal);
  return ipv4?.address ?? "172.17.0.1";
}

export interface SecretProxy {
  port: number;
  url: string;
  close: () => Promise<void>;
}

function copyHeaders(
  req: IncomingMessage,
  extra: Record<string, string>,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  }
  Object.assign(headers, extra);
  return headers;
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  extraHeaders: Record<string, string>,
): void {
  const transport = target.protocol === "http:" ? httpRequest : httpsRequest;
  const upstream = transport(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: copyHeaders(req, extraHeaders),
    },
    (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

/** Largest request body we keep a copy of so the anonymous retry can replay it. */
const MAX_REPLAY_BODY_BYTES = 8 * 1024 * 1024;
/** Largest rejected response we keep so a failed retry can surface the original. */
const MAX_HELD_RESPONSE_BYTES = 64 * 1024;

/**
 * Forwards like {@link forward}, but retries once without the injected GitHub
 * credential when that credential is what GitHub rejected, so a stale token
 * cannot break public clones.
 */
function forwardWithAuthFallback(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  baseHeaders: Record<string, string>,
  authHeader: string | undefined,
): void {
  const transport = target.protocol === "http:" ? httpRequest : httpsRequest;
  const replay: Buffer[] = [];
  let replayBytes = 0;
  // Past the cap we drop the copy instead of holding a whole push pack in host
  // memory; the streamed attempt still completes, it just cannot be retried.
  let replayable = true;
  let requestEnded = false;
  let afterRequestEnd: (() => void) | undefined;

  req.on("data", (chunk: Buffer) => {
    if (!replayable) return;
    replayBytes += chunk.length;
    if (replayBytes > MAX_REPLAY_BODY_BYTES) {
      replay.length = 0;
      replayable = false;
      return;
    }
    replay.push(chunk);
  });
  req.on("end", () => {
    requestEnded = true;
    afterRequestEnd?.();
  });
  req.on("error", () => {
    replayable = false;
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });

  const options = (withAuth: boolean): RequestOptions => {
    const headers = copyHeaders(req, {
      ...baseHeaders,
      ...(withAuth && authHeader ? { authorization: authHeader } : {}),
    });
    // The anonymous attempt has to be anonymous: copyHeaders would otherwise
    // pass a client-sent Authorization straight through.
    if (!withAuth) delete headers.authorization;
    return {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    };
  };

  // A 401 means the credential itself was refused, so dropping it can only
  // help. A 403 is GitHub answering "not allowed" for a token that works —
  // retrying a write would turn a clear permission error into a confusing
  // anonymous 401, so only safe reads fall back on it.
  const shouldRetry = (status: number): boolean =>
    status === 401 || (status === 403 && req.method === "GET");

  const relay = (incoming: IncomingMessage): void => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(res);
  };

  const failGateway = (): void => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  };

  const sendHeld = (held: HeldResponse): void => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const headers = { ...held.headers };
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    res.writeHead(held.status, headers);
    res.end(held.body ?? undefined);
  };

  const hold = (incoming: IncomingMessage, done: (held: HeldResponse) => void): void => {
    const status = incoming.statusCode ?? 502;
    const parts: Buffer[] = [];
    let size = 0;
    let kept = true;
    incoming.on("data", (chunk: Buffer) => {
      if (!kept) return;
      size += chunk.length;
      if (size > MAX_HELD_RESPONSE_BYTES) {
        parts.length = 0;
        kept = false;
        return;
      }
      parts.push(chunk);
    });
    incoming.on("error", () => done({ status, headers: incoming.headers, body: null }));
    incoming.on("end", () =>
      done({ status, headers: incoming.headers, body: kept ? Buffer.concat(parts) : null }),
    );
  };

  const retryAnonymously = (held: HeldResponse): void => {
    const anonymous = transport(options(false), (incoming) => {
      // The token was not the problem after all — keep the authenticated answer
      // so permission errors stay permission errors.
      if ((incoming.statusCode ?? 502) >= 400 && held.body) {
        incoming.resume();
        sendHeld(held);
        return;
      }
      relay(incoming);
    });
    anonymous.on("error", () => (held.body ? sendHeld(held) : failGateway()));
    anonymous.end(Buffer.concat(replay));
  };

  const authenticated = transport(options(true), (incoming) => {
    if (!authHeader || !replayable || !shouldRetry(incoming.statusCode ?? 502)) {
      relay(incoming);
      return;
    }
    hold(incoming, (held) => {
      // The retry replays the body, so it has to wait until we have all of it.
      if (requestEnded) retryAnonymously(held);
      else afterRequestEnd = () => retryAnonymously(held);
    });
  });
  authenticated.on("error", failGateway);
  req.pipe(authenticated);
}

function listen(
  bindHost: string,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<SecretProxy> {
  const server = createServer((req, res) => {
    void Promise.resolve(onRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        url: `http://${bindHost}:${addr.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

/** Reverse-proxy to api.x.ai that injects the host credential. Bind to the docker bridge only. */
export function startXaiProxy(opts: {
  bindHost: string;
  bearerToken?: string;
  getBearer?: () => string | Promise<string>;
  targetOrigin?: string;
}): Promise<SecretProxy> {
  const origin = opts.targetOrigin ?? "https://api.x.ai";
  const resolveBearer = async (): Promise<string> => {
    if (opts.getBearer) return await opts.getBearer();
    if (opts.bearerToken) return opts.bearerToken;
    throw new Error("xAI proxy has no bearer token");
  };
  return listen(opts.bindHost, async (req, res) => {
    const token = await resolveBearer();
    const target = new URL(req.url ?? "/", origin);
    forward(req, res, target, {
      host: target.host,
      authorization: `Bearer ${token}`,
    });
  });
}

export function parseGithubProxyPath(urlPath: string): { host: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(urlPath, "http://sroc-proxy.local");
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/https\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const host = match[1];
  if (!GITHUB_HOSTS.has(host)) return null;
  return { host, path: `${match[2] || "/"}${parsed.search}` };
}

/** Path-prefixed proxy: /https/github.com/... and /https/api.github.com/... */
export function startGithubProxy(opts: {
  bindHost: string;
  bearerToken: string;
  testOrigins?: Record<string, string>;
}): Promise<SecretProxy> {
  // Only build a credential when we actually have a token; an empty token would
  // otherwise turn every request into a guaranteed 401.
  const authHeader = opts.bearerToken
    ? `Basic ${Buffer.from(`x-access-token:${opts.bearerToken}`).toString("base64")}`
    : undefined;
  return listen(opts.bindHost, (req, res) => {
    const routed = parseGithubProxyPath(req.url ?? "/");
    if (!routed) {
      res.writeHead(403);
      res.end("host not allowed");
      return;
    }
    const origin = opts.testOrigins?.[routed.host] ?? `https://${routed.host}`;
    const target = new URL(routed.path, origin);
    forwardWithAuthFallback(req, res, target, { host: new URL(origin).host }, authHeader);
  });
}

export function githubInsteadOfCommands(githubProxyUrl: string): string[][] {
  const prefix = `${githubProxyUrl.replace(/\/$/, "")}/https`;
  return [
    ["git", "config", "--global", `url.${prefix}/github.com/.insteadOf`, "https://github.com/"],
    [
      "git",
      "config",
      "--global",
      `url.${prefix}/api.github.com/.insteadOf`,
      "https://api.github.com/",
    ],
  ];
}
