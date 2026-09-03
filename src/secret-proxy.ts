import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

/**
 * Like {@link forward}, but buffers the request body so it can retry.
 *
 * The GitHub proxy injects a `Basic` credential on every request. If that
 * credential is missing, expired, or lacks access, GitHub answers 401/403 even
 * for public repositories that would clone fine anonymously — and git, running
 * with `GIT_TERMINAL_PROMPT=0`, then dies with "could not read Username ...
 * terminal prompts disabled" instead of falling back to unauthenticated
 * access. To keep public clones working regardless of token health, retry the
 * request once without the injected Authorization header when the first,
 * authenticated attempt is rejected.
 */
function forwardWithAuthFallback(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  baseHeaders: Record<string, string>,
  authHeader: string | undefined,
): void {
  const chunks: Buffer[] = [];
  req.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const transport = target.protocol === "http:" ? httpRequest : httpsRequest;

    const attempt = (withAuth: boolean): void => {
      const extraHeaders = { ...baseHeaders };
      if (withAuth && authHeader) extraHeaders.authorization = authHeader;
      else delete extraHeaders.authorization;
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
          const status = incoming.statusCode ?? 502;
          if (withAuth && authHeader && (status === 401 || status === 403)) {
            incoming.resume(); // drain so the socket can be reused
            attempt(false);
            return;
          }
          res.writeHead(status, incoming.headers);
          incoming.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    };

    attempt(Boolean(authHeader));
  });
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
