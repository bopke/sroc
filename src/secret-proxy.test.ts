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
});
