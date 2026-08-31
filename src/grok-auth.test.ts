import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createGrokAuth } from "./grok-auth.js";

function writeAuth(dir: string, session: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      "https://auth.x.ai::client": session,
    }),
  );
}

describe("createGrokAuth", () => {
  it("prefers a grok login session over XAI_API_KEY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sroc-auth-"));
    writeAuth(dir, {
      key: "session-jwt",
      refresh_token: "refresh",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      oidc_client_id: "client",
      oidc_issuer: "https://auth.x.ai",
    });
    const auth = createGrokAuth({ grokHome: dir, apiKey: "xai-console" });
    assert.equal(auth.source(), "session");
    assert.equal(auth.label(), "grok login (SuperGrok)");
    assert.equal(await auth.getBearer(), "session-jwt");
  });

  it("falls back to XAI_API_KEY when there is no auth.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sroc-auth-"));
    const auth = createGrokAuth({ grokHome: dir, apiKey: "xai-console" });
    assert.equal(auth.source(), "api_key");
    assert.equal(await auth.getBearer(), "xai-console");
  });

  it("refreshes an expired session and writes the new token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sroc-auth-"));
    writeAuth(dir, {
      key: "old-jwt",
      refresh_token: "refresh-old",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      oidc_client_id: "client",
      oidc_issuer: "https://auth.x.ai",
    });

    const server = createServer((req, res) => {
      assert.equal(req.method, "POST");
      res.end(
        JSON.stringify({
          access_token: "new-jwt",
          refresh_token: "refresh-new",
          expires_in: 3600,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const auth = createGrokAuth({
      grokHome: dir,
      tokenUrl: `http://127.0.0.1:${port}/oauth2/token`,
    });
    assert.equal(await auth.getBearer(), "new-jwt");
    const stored = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as {
      "https://auth.x.ai::client": { key: string; refresh_token: string };
    };
    assert.equal(stored["https://auth.x.ai::client"].key, "new-jwt");
    assert.equal(stored["https://auth.x.ai::client"].refresh_token, "refresh-new");

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
