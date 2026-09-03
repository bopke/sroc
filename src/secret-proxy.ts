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

function githubBasicAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/** Path-prefixed proxy: /https/github.com/... and /https/api.github.com/... */
export function startGithubProxy(opts: {
  bindHost: string;
  bearerToken?: string;
  getBearer?: () => string | Promise<string>;
  testOrigins?: Record<string, string>;
}): Promise<SecretProxy> {
  const resolveBearer = async (): Promise<string | undefined> => {
    if (opts.getBearer) {
      const token = await opts.getBearer();
      return token || undefined;
    }
    if (opts.bearerToken) return opts.bearerToken;
    return undefined;
  };
  return listen(opts.bindHost, async (req, res) => {
    const routed = parseGithubProxyPath(req.url ?? "/");
    if (!routed) {
      res.writeHead(403);
      res.end("host not allowed");
      return;
    }
    const origin = opts.testOrigins?.[routed.host] ?? `https://${routed.host}`;
    const target = new URL(routed.path, origin);
    const extra: Record<string, string> = { host: new URL(origin).host };
    const token = await resolveBearer();
    if (token) extra.authorization = githubBasicAuth(token);
    forward(req, res, target, extra);
  });
}

const PROXY_INSTEADOF_KEY =
  /^url\.(http:\/\/host\.docker\.internal:\d+\/https\/(?:github\.com|api\.github\.com)\/)\.insteadof$/i;

/** Sections from `git config --list` that rewrite GitHub through an old proxy port. */
export function staleGithubInsteadOfSections(
  existingConfigList: string,
  githubProxyUrl: string,
): string[] {
  const prefix = `${githubProxyUrl.replace(/\/$/, "")}/https`;
  const keep = new Set([`url.${prefix}/github.com/`, `url.${prefix}/api.github.com/`]);
  const sections: string[] = [];
  for (const line of existingConfigList.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const match = line.slice(0, eq).match(PROXY_INSTEADOF_KEY);
    if (!match) continue;
    const section = `url.${match[1]}`;
    if (!keep.has(section)) sections.push(section);
  }
  return sections;
}

export function githubInsteadOfCommands(
  githubProxyUrl: string,
  existingConfigList = "",
): string[][] {
  const prefix = `${githubProxyUrl.replace(/\/$/, "")}/https`;
  const cmds = staleGithubInsteadOfSections(existingConfigList, githubProxyUrl).map((section) => [
    "git",
    "config",
    "--global",
    "--remove-section",
    section,
  ]);
  cmds.push(
    ["git", "config", "--global", `url.${prefix}/github.com/.insteadOf`, "https://github.com/"],
    [
      "git",
      "config",
      "--global",
      `url.${prefix}/api.github.com/.insteadOf`,
      "https://api.github.com/",
    ],
  );
  return cmds;
}
