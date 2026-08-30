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
`DISCORD_GUILD_ID`, and `XAI_API_KEY` (or `GROK_API_KEY`). Optional: `GROK_MODEL`
(default `grok-build`; `default` omits `-m` so the CLI uses its configured
model), `GROK_BIN`, `GROK_CWD` (default `./workspace`),
`GROK_ALWAYS_APPROVE` (default true), `GROK_SANDBOX` (default `workspace`),
`GROK_TIMEOUT_MS` (default 600000).

`src/config.ts` throws on import if required env is missing. Tests must not
import `config.ts` or `index.ts`. `src/grok.ts` is safe to import in tests: it
does not load config.

The `grok` CLI must be on `PATH` (or set `GROK_BIN`) at runtime. Unit tests do
not spawn it.

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
| `src/conversation.ts`    | Mention stripping, assistant-message check, session-id lookup, `--rules` text |
| `src/discordContext.ts`  | Format incoming Discord messages as plain text for Grok                       |
| `src/commands/`          | One file per command; register in `src/commands/index.ts`                     |
| `src/types.ts`           | `Command` interface (`data`, `execute`, `runText`)                            |
| `src/deploy-commands.ts` | Guild-scoped slash command deploy                                             |
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
the process still restarts after a successful build.

systemd system units often omit `HOME`. Git then cannot read `~/.gitconfig` (the
`gh` credential helper) and HTTPS pulls fail with "terminal prompts disabled".
`commandEnv()` always sets `HOME` to `os.homedir()`. Keep `Environment=HOME=`
in `sroc.service` as well.

## Invariants — do not break these

- **One guild.** Ignore DMs and any guild other than `config.guildId`.
- **Triggers.** Reply to a tracked _assistant_ message → continue that branch (`parent_message_id` = that id, resume its `grok_session_id`). Else `@mention` the bot → new root (`parent_message_id` null, new Grok session). Else ignore. A mention on a continue-reply is just text, not a new conversation.
- **Tree, not thread.** Multiple replies to the same bot message are sibling branches. Always `--resume <parent session> --fork-session` so the parent session is not mutated.
- **Grok Build owns history.** Send only the new user turn as `-p`. Do not rebuild a chat-completions message list. Do not call the OpenAI/xAI HTTP chat API.
- **`--rules`, not `--system-prompt-override`.** Discord `/systemprompt` is extra rules on **new** sessions only. Overriding the system prompt would strip Grok Build's coding-agent instructions. In-flight sessions keep the rules they were created with.
- **`system_prompt_id` only on roots** (Discord-side audit). `grok_session_id` only on assistant rows. Anyone may change the Discord system prompt — no permission gate.
- **Failed Grok run:** log, edit the `-# Working...` message to a short apology, **do not persist** the user or assistant node (retry-by-reply must land on the same valid parent).
- **Long replies:** split on the nearest preceding newline at 2000 chars. The `-# Working...` reply is edited into the first chunk; later chunks are untracked channel messages. The last sent message id is the `assistant` row (the one a user must reply to in order to continue).
- **Stored user content** is `formatIncomingContent(...)` output (`Speaker (@username): body`), with the bot mention stripped. Attachments/embeds are text notes (name/url/title), not file bytes.
- **Legacy rows** with a null `grok_session_id` start a fresh Grok session (still parented in the Discord tree).

## Grok Build

`src/grok.ts` spawns `grok -p` with `--output-format streaming-json --verbatim`. Pass `XAI_API_KEY` and `GROK_DISABLE_AUTOUPDATER=1` in the child env. Keep `GrokBuildClient.prompt` as the only runtime entry point.

Do not add the `openai` package back, and do not use `--system-prompt-override`.
