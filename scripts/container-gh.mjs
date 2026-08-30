#!/usr/bin/env node
/**
 * gh(1) stand-in for conversation containers. Talks to the host GitHub proxy;
 * no token is present in this process environment.
 */
import { execFileSync } from "node:child_process";

const proxy = process.env.SROC_GH_PROXY;
if (!proxy) {
  console.error("SROC_GH_PROXY is not set; GitHub is not available in this container.");
  process.exit(1);
}

const args = process.argv.slice(2);

function api(method, path, body) {
  const url = `${proxy.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sroc-container-gh",
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(url, init).then(async (res) => {
    const text = await res.text();
    if (!res.ok) {
      console.error(text || `${res.status} ${res.statusText}`);
      process.exit(1);
    }
    if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  });
}

function flag(name, fallback) {
  const long = `--${name}`;
  const i = args.indexOf(long);
  if (i >= 0) return args[i + 1] ?? fallback;
  return fallback;
}

function git(cmd) {
  return execFileSync("git", cmd, { encoding: "utf8" }).trim();
}

function originRepo() {
  const raw = git(["remote", "get-url", "origin"]);
  const match = raw.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/);
  if (!match) {
    console.error(`Cannot parse GitHub owner/repo from origin: ${raw}`);
    process.exit(1);
  }
  return { owner: match[1], repo: match[2] };
}

async function main() {
  if (args[0] === "auth") {
    console.log("github.com as sroc (host proxy)");
    return;
  }

  if (args[0] === "api") {
    let method = "GET";
    const rest = args.slice(1);
    if (rest[0] === "-X" || rest[0] === "--method") {
      method = rest[1];
      rest.splice(0, 2);
    }
    const path = rest[0];
    if (!path) {
      console.error("Usage: gh api [-X METHOD] /path");
      process.exit(1);
    }
    await api(method, path);
    return;
  }

  if (args[0] === "repo" && args[1] === "clone") {
    const spec = args[2];
    if (!spec) {
      console.error("Usage: gh repo clone owner/repo");
      process.exit(1);
    }
    const dest = args[3];
    const url = spec.includes("github.com") ? spec : `https://github.com/${spec}.git`;
    execFileSync("git", dest ? ["clone", url, dest] : ["clone", url], { stdio: "inherit" });
    return;
  }

  if (args[0] === "pr" && args[1] === "create") {
    const { owner, repo } = originRepo();
    const title = flag("title", flag("t", "PR from sroc"));
    const body = flag("body", flag("b", ""));
    const base = flag("base", "main");
    const head = flag("head", git(["rev-parse", "--abbrev-ref", "HEAD"]));
    await api("POST", `/repos/${owner}/${repo}/pulls`, { title, body, head, base });
    return;
  }

  console.error("sroc gh wrapper supports: gh auth, gh api, gh repo clone, gh pr create");
  process.exit(1);
}

await main();
