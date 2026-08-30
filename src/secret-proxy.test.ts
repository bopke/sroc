import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { startXaiProxy } from "./secret-proxy.js";
import { CONTAINER_XAI_PLACEHOLDER, containerGrokConfig } from "./isolate.js";

describe("containerGrokConfig", () => {
  it("restricts tool env and points inference at the host proxy", () => {
    const toml = containerGrokConfig("http://host.docker.internal:9");
    assert.match(toml, /include_only/);
    assert.match(toml, /xai_api_base_url = "http:\/\/host\.docker\.internal:9"/);
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
      bearerToken: "real-secret",
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
