import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { parseGithubProxyPath, startGithubProxy, startXaiProxy } from "./secret-proxy.js";
import { CONTAINER_XAI_PLACEHOLDER, containerGrokConfig, grokXaiApiBaseUrl } from "./isolate.js";

describe("grokXaiApiBaseUrl", () => {
  it("appends /v1 to match grok's default https://api.x.ai/v1", () => {
    assert.equal(
      grokXaiApiBaseUrl("http://host.docker.internal:9"),
      "http://host.docker.internal:9/v1",
    );
    assert.equal(
      grokXaiApiBaseUrl("http://host.docker.internal:9/"),
      "http://host.docker.internal:9/v1",
    );
    assert.equal(
      grokXaiApiBaseUrl("http://host.docker.internal:9/v1"),
      "http://host.docker.internal:9/v1",
    );
  });
});

describe("containerGrokConfig", () => {
  it("restricts tool env and points inference at the host proxy", () => {
    const toml = containerGrokConfig("http://host.docker.internal:9");
    assert.match(toml, /include_only/);
    assert.match(toml, /preferred_method = "api_key"/);
    assert.match(toml, /xai_api_base_url = "http:\/\/host\.docker\.internal:9\/v1"/);
    assert.doesNotMatch(toml, /xai-/);
    assert.doesNotMatch(toml, /gho_/);
  });
});

describe("startXaiProxy", () => {
  it("replaces Authorization with the real bearer token", async () => {
    const upstream = createServer((req, res) => {
      res.end(JSON.stringify({ auth: req.headers.authorization ?? "" }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;

    const proxy = await startXaiProxy({
      bindHost: "127.0.0.1",
      getBearer: () => "real-secret",
      targetOrigin: `http://127.0.0.1:${upPort}`,
    });

    const response = await fetch(`${proxy.url}/v1/ping`, {
      headers: { authorization: `Bearer ${CONTAINER_XAI_PLACEHOLDER}` },
    });
    const body = (await response.json()) as { auth: string };
    assert.equal(body.auth, "Bearer real-secret");

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });
});

describe("parseGithubProxyPath", () => {
  it("allows github.com and api.github.com only", () => {
    assert.deepEqual(
      parseGithubProxyPath("/https/github.com/bopke/sroc.git/info/refs?service=git-upload-pack"),
      {
        host: "github.com",
        path: "/bopke/sroc.git/info/refs?service=git-upload-pack",
      },
    );
    assert.equal(parseGithubProxyPath("/https/evil.example/secret"), null);
    assert.equal(parseGithubProxyPath("/v1/foo"), null);
  });
});

describe("startGithubProxy", () => {
  it("forwards to the allowlisted host with injected basic auth", async () => {
    const upstream = createServer((req, res) => {
      res.end(JSON.stringify({ auth: req.headers.authorization ?? "", url: req.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "gh-secret",
      testOrigins: { "api.github.com": origin, "github.com": origin },
    });

    const response = await fetch(`${proxy.url}/https/api.github.com/repos/bopke/sroc`);
    const body = (await response.json()) as { auth: string; url: string };
    assert.equal(body.url, "/repos/bopke/sroc");
    assert.match(body.auth, /^Basic /);
    assert.equal(
      Buffer.from(body.auth.replace("Basic ", ""), "base64").toString(),
      "x-access-token:gh-secret",
    );

    const denied = await fetch(`${proxy.url}/https/evil.example/x`);
    assert.equal(denied.status, 403);

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("retries without auth when the injected credential is rejected", async () => {
    let sawAuthAttempt = false;
    let servedAnonymously = false;
    const upstream = createServer((req, res) => {
      if (req.headers.authorization) {
        sawAuthAttempt = true;
        res.writeHead(401);
        res.end("bad credentials");
        return;
      }
      servedAnonymously = true;
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "expired-token",
      testOrigins: { "github.com": origin, "api.github.com": origin },
    });

    const response = await fetch(`${proxy.url}/https/github.com/octocat/Hello-World`);
    const body = (await response.json()) as { ok: boolean };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(sawAuthAttempt, true, "should try the credential first");
    assert.equal(servedAnonymously, true, "should fall back to an anonymous request");

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("replays a POST body on the anonymous retry", async () => {
    const bodies: { auth: string | undefined; body: string }[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push({
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        });
        if (req.headers.authorization) {
          res.writeHead(401);
          res.end("bad credentials");
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "expired-token",
      testOrigins: { "github.com": origin, "api.github.com": origin },
    });

    const response = await fetch(
      `${proxy.url}/https/github.com/octocat/Hello-World.git/git-upload-pack`,
      {
        method: "POST",
        body: "0032want 0000000000000000000000000000000000000000\n0000",
      },
    );
    const body = (await response.json()) as { ok: boolean };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(bodies.length, 2, "should try the credential, then retry anonymously");
    assert.ok(bodies[0].auth, "first attempt carries the injected credential");
    assert.equal(bodies[1].auth, undefined, "retry is anonymous");
    assert.equal(bodies[0].body, bodies[1].body, "retry replays the same body");
    assert.match(bodies[1].body, /want 0{40}/);

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("retries a 403 on a read but not on a write", async () => {
    const seen: { method: string | undefined; auth: string | undefined }[] = [];
    const upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({ method: req.method, auth: req.headers.authorization });
        if (req.headers.authorization) {
          res.writeHead(403);
          res.end("Write access to repository not granted");
          return;
        }
        res.end(JSON.stringify({ anonymous: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "read-only-token",
      testOrigins: { "github.com": origin, "api.github.com": origin },
    });

    const read = await fetch(`${proxy.url}/https/github.com/octocat/Hello-World/info/refs`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()) as { anonymous: boolean }, { anonymous: true });
    assert.equal(seen.length, 2, "a 403 on a GET falls back to anonymous");

    const write = await fetch(
      `${proxy.url}/https/github.com/octocat/Hello-World.git/git-receive-pack`,
      {
        method: "POST",
        body: "pack",
      },
    );
    assert.equal(write.status, 403, "a 403 on a write stays a 403");
    assert.equal(await write.text(), "Write access to repository not granted");
    assert.equal(seen.length, 3, "the write is not retried anonymously");

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("keeps the authenticated response when the anonymous retry also fails", async () => {
    let attempts = 0;
    const upstream = createServer((req, res) => {
      attempts += 1;
      if (req.headers.authorization) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Bad credentials");
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "expired-token",
      testOrigins: { "github.com": origin, "api.github.com": origin },
    });

    const response = await fetch(`${proxy.url}/https/github.com/octocat/private-repo`);
    assert.equal(attempts, 2);
    assert.equal(response.status, 401, "the original rejection is what the client sees");
    assert.equal(await response.text(), "Bad credentials");

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("drops a client-sent Authorization header on the anonymous retry", async () => {
    const auths: (string | undefined)[] = [];
    const upstream = createServer((req, res) => {
      auths.push(req.headers.authorization);
      if (req.headers.authorization) {
        res.writeHead(401);
        res.end("bad credentials");
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "expired-token",
      testOrigins: { "github.com": origin, "api.github.com": origin },
    });

    const response = await fetch(`${proxy.url}/https/github.com/octocat/Hello-World`, {
      headers: { authorization: "Bearer client-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(auths.length, 2);
    assert.equal(auths[1], undefined, "the retry must not carry the client credential");

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("sends no Authorization header when there is no token", async () => {
    let receivedAuth: string | undefined;
    const upstream = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${upPort}`;

    const proxy = await startGithubProxy({
      bindHost: "127.0.0.1",
      bearerToken: "",
      testOrigins: { "github.com": origin, "api.github.com": origin },
    });

    const response = await fetch(`${proxy.url}/https/github.com/octocat/Hello-World`);
    assert.equal(response.status, 200);
    assert.equal(receivedAuth, undefined);

    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
