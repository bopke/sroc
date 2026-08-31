# AGENTS.md

Instructions for coding agents working in this repository.

## What this is

`sroc` is a single-guild Discord bot (TypeScript, ESM, Node >= 20). Chat and
coding go through the **Grok Build CLI** (`grok -p`), not the xAI chat-completions
API. Discord conversations are a **tree** of messages; each assistant reply stores
a Grok Build `sessionId` so replies can resume or fork that session.

Human-facing setup lives in `README.md`. The original chatbot design in
`docs/superpowers/specs/2026-08-25-grok-chatbot-design.md` still describes Discord
triggers and the SQLite tree; ignore its OpenAI/`summarize`/HISTORY_WINDOW sections.

## Commands

```bash
npm install
npm test                 # Node's built-in test runner on src/**/*.test.ts
npm run lint
npm run format           # Prettier, printWidth 100, trailingComma all
npm run build            # tsc → dist/; test files are excluded
npm run dev              # tsx watch src/index.ts
npm start                # node dist/index.js (build first)
npm run deploy-commands  # PUT guild slash commands; re-run after adding/changing commands
```

Production is `sroc.service` (systemd). Paths in that file assume this checkout
is `/root/sroc`. The operator symlinks it into `/etc/systemd/system/` — do not
install or enable the unit as part of a code change.

Do not commit `.env`, `data/`, `workspace/`, or `dist/`. Copy `.env.example` for
local credentials. Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
`DISCORD_GUILD_ID`, `OWNER_ID`. Grok auth: `grok login` on the host (SuperGrok
subscription) or `XAI_API_KEY` / `GROK_API_KEY` (console, pay-per-token). Optional: `GROK_MODEL`
(default `grok-build`; `default` omits `-m` so the CLI uses its configured
model), `GROK_BIN`, `GROK_CWD` (default `./workspace`),
`GROK_ALWAYS_APPROVE` (default true), `GROK_SANDBOX` (default `workspace`; ignored
when isolate is on), `GROK_TIMEOUT_MS` (default 600000), `GROK_ISOLATE` (default
true), `GROK_REPO_URL`, `GITHUB_TOKEN`, `GROK_ISOLATE_IMAGE`.

`src/config.ts` throws on import if required env is missing. Tests must not
import `config.ts` or `index.ts`. `src/grok.ts` is safe to import in tests: it
does not load config.

The `grok` CLI must be on `PATH` (or set `GROK_BIN`) at runtime when
`GROK_ISOLATE=false`. Isolated mode (default) docker-execs `grok` inside
`sroc-agent:latest`. Unit tests do not spawn grok or docker.

## Version control

Commit and push to `origin` after each coherent unit of work. Do not wait for
the user to ask. Skip only if the change is still mid-flight or blocked. Never
commit `.env`, `data/`, `workspace/`, or `dist/`.

## Layout

| Path                     | Role                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `src/index.ts`           | Client, intents, slash/`$` dispatch, chat trigger, progress, reply splitting  |
| `src/config.ts`          | Env loading                                                                   |
| `src/db.ts`              | SQLite schema + queries. Default export opens `data/bot.db` at import         |
| `src/grok.ts`            | Grok Build CLI wrapper (`GrokBuildClient`, arg builder, stream parser)        |
| `src/isolate.ts`         | Per-conversation Docker workspace (create, exec, prune)                       |
| `Dockerfile.agent`       | Image `sroc-agent:latest` with grok + git + node                              |
| `src/conversation.ts`    | Mention stripping, assistant-message check, session-id lookup, `--rules` text |
| `src/discordContext.ts`  | Format incoming Discord messages as plain text for Grok                       |
| `src/commands/`          | One file per command; register in `src/commands/index.ts`                     |
| `src/types.ts`           | `Command` interface (`data`, `execute`, `runText`)                            |
| `src/deploy-commands.ts` | Guild + global slash command deploy (global is for owner DMs)                 |
| `sroc.service`           | systemd unit; operator symlinks into `/etc/systemd/system/`                   |

## Conventions

- TypeScript **strict**, `module`/`moduleResolution` `NodeNext`. Use `.js` extensions in relative imports even though sources are `.ts`.
- ESM only (`"type": "module"`).
- Colocate tests as `src/*.test.ts`. They are excluded from `tsc`. Use `node:test` + `node:assert/strict`.
- Discord I/O is not unit-tested. Cover routing and CLI helpers with an in-memory DB: `openDatabase(":memory:")`. Never use the default `db` export in tests — it opens the real file and has import side effects.
- Do not spawn `grok` in unit tests. Test `buildGrokArgs` / `parseStreamLine` / `reduceStdout`.
- Match existing style: 2-space indent, no narrating comments, short factual comments only for non-obvious constraints.

## Adding a command

1. Create `src/commands/<name>.ts` exporting a `Command`.
2. Implement both `execute` (slash) and `runText` (`$name ...args`). See `src/commands/ping.ts`.
3. Append it to `commands` in `src/commands/index.ts`.
4. Run `npm run deploy-commands`.

`$` text-command replies are always public channel messages (Discord cannot make them ephemeral). Slash `view`/`history` for `/systemprompt` are ephemeral; `set` is public.

`/deploy` (`src/commands/deploy.ts`) runs `git pull --ff-only`, `npm run build`,
and `npm run deploy-commands` in the bot checkout, then `process.exit(0)` so
systemd restarts the new `dist/`. A unit restart alone does not compile
TypeScript (`dist/` is gitignored). Do not add `ExecStartPre` rebuilds; `/deploy`
is the intended path. Deploy-commands is best-effort: a failure is reported but
the process still restarts after a successful build. On success, persist the
reply's `channel_id`/`message_id` in `deploy_notice` (singleton). After
`ClientReady`, wait 10 seconds then fetch and delete that message and clear
the row. Failed deploys do not store a notice.

systemd system units often omit `HOME`. Git then cannot read `~/.gitconfig` (the
`gh` credential helper) and HTTPS pulls fail with "terminal prompts disabled".
`commandEnv()` always sets `HOME` to `os.homedir()`. Keep `Environment=HOME=`
in `sroc.service` as well.

Do not put `XAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `DISCORD_TOKEN`, or
`~/.grok/auth.json` in the container. xAI and GitHub HTTPS go through
`src/secret-proxy.ts` on the docker bridge. The xAI proxy prefers the host
`grok login` session (SuperGrok) and falls back to `XAI_API_KEY`. Git uses
`url.*.insteadOf` to the proxy; `gh` is `scripts/container-gh.mjs` (no token).
Dummy `XAI_API_KEY=sroc-local` only so the inner CLI will start.
Grok's `xai_api_base_url` / `GROK_XAI_API_BASE_URL` must be the proxy origin plus `/v1`
(the CLI default is `https://api.x.ai/v1`; without it, grok hits `/models` and xAI 404s).
Tool shells get `[shell_environment_policy] include_only`.

## Invariants — do not break these

- **One guild + owner DMs.** Ignore any guild other than `config.guildId`. Ignore DMs unless `author.id === config.ownerId`. Other users' DMs get no response (including slash commands — do not reply).
- **Triggers.** Reply to a tracked _assistant_ message → continue that branch (`parent_message_id` = that id, resume its `grok_session_id`). Else `@mention` the bot → new root (`parent_message_id` null, new Grok session). Else ignore in guilds. In owner DMs, a non-reply non-mention continues the latest assistant in that DM channel (or starts new if none). A mention on a continue-reply is just text, not a new conversation.
- **Prompt scopes.** `system_prompts.scope` is `guild` or `dm`. `/systemprompt` in a guild mutates guild; in a DM mutates dm. They must not leak. Use `getCurrentSystemPrompt(db, promptScope(guildId))`.
- **Tree, not thread.** Multiple replies to the same bot message are sibling branches. Always `--resume <parent session> --fork-session` so the parent session is not mutated.
- **Grok Build owns history.** Send only the new user turn as `-p`. Do not rebuild a chat-completions message list. Do not call the OpenAI/xAI HTTP chat API.
- **`--rules`, not `--system-prompt-override`.** Discord `/systemprompt` is extra rules on **new** sessions only. Overriding the system prompt would strip Grok Build's coding-agent instructions. In-flight sessions keep the rules they were created with.
- **`system_prompt_id` only on roots** (Discord-side audit). `grok_session_id` only on assistant rows. Anyone in the guild may change the guild system prompt; only the owner can change the DM prompt (because only they can DM).
- **Failed Grok run:** log, send a short apology, **do not persist** the user or assistant node (retry-by-reply must land on the same valid parent). If a `-# Working...` status exists, delete it before replying; otherwise just reply.
- **Working status:** do not post `-# Working...` until the turn has been running for 10 seconds. Fast replies have no status message. The status message (if posted) is deleted as soon as the final result arrives.
- **Long replies:** split on the nearest preceding newline at 2000 chars. The final result is always sent as a fresh `message.reply(...)` (the temporary Working... message is deleted first). Later chunks are untracked channel messages. The last sent message id is the `assistant` row (the one a user must reply to in order to continue).
- **Stored user content** is `formatIncomingContent(...)` output (`Speaker (@username): body`), with the bot mention stripped. Attachments/embeds are text notes (name/url/title), not file bytes.
- **Legacy rows** with a null `grok_session_id` start a fresh Grok session (still parented in the Discord tree).
- **Isolate by default.** Each conversation root gets a Docker container
  (`sroc-ws-<workspace_id>`, label `sroc.workspace=1`). Do **not** clone the
  repo on provision unless `GROK_ISOLATE_CLONE=true` — an empty workspace keeps
  simple chat fast. Tell Grok the repo URL in `--rules` so it can clone when
  the user asks for file/PR work. The bot now defaults to `GIT_USER_NAME=Bopke`
  - `GIT_USER_EMAIL=bot@bopke.dev` (your dedicated bot account). Provision git
    identity and `url.*.insteadOf` when `GITHUB_TOKEN` is set, so `gh pr create`
    works. Do not mount the host checkout, `.env`, or
    `data/`. Do not pass `DISCORD_TOKEN` into the container. Inner grok sandbox
    is `off`; Docker is the isolation. Default `--no-plan`, `--no-subagents`,
    `--effort low`. Copy `workspace_id` from the parent message; new roots use
    the incoming Discord message id. `/isolate prune` (owner) is the removal path.

## Grok Build

`src/grok.ts` spawns `grok -p` (or `docker exec … grok -p` when isolated) with
`--output-format streaming-json --verbatim`. Isolated grok gets dummy
`XAI_API_KEY=sroc-local` and `GROK_DISABLE_AUTOUPDATER=1`; the host proxy
injects the SuperGrok session (or console key). Keep `GrokBuildClient.prompt`
as the only runtime entry point.

Do not add the `openai` package back, and do not use `--system-prompt-override`.
