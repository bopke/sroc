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

/** Reverse-proxy to api.x.ai that injects the real key. Bind to the docker bridge only. */
export function startXaiProxy(opts: {
  bindHost: string;
  bearerToken: string;
  targetOrigin?: string;
}): Promise<SecretProxy> {
  const target = new URL(opts.targetOrigin ?? "https://api.x.ai");
  const transport = target.protocol === "http:" ? httpRequest : httpsRequest;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }
    headers.host = target.host;
    headers.authorization = `Bearer ${opts.bearerToken}`;

    const upstream = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: req.url,
        method: req.method,
        headers,
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
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, opts.bindHost, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        url: `http://${opts.bindHost}:${addr.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
