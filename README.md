# sroc

A Discord bot written in TypeScript using [discord.js](https://discord.js.org/), backed by
[Grok Build](https://docs.x.ai) (the `grok` CLI) for chat and coding in a workspace.

## Setup

1. Install the [Grok CLI](https://x.ai/cli/install.sh) and confirm `grok --version` works.
2. Copy `.env.example` to `.env` and fill in your credentials:

   ```
   DISCORD_TOKEN=
   DISCORD_CLIENT_ID=
   DISCORD_GUILD_ID=      # required — the single guild the bot operates in
   OWNER_ID=              # required — only this user can talk to the bot in DMs
   XAI_API_KEY=           # from https://console.x.ai (GROK_API_KEY still accepted)
   GROK_MODEL=grok-build  # optional; "default" uses the CLI's configured model
   ```

   Optional: `GROK_CWD` (project the agent works in; default `./workspace`),
   `GROK_BIN`, `GROK_ALWAYS_APPROVE` (default true), `GROK_SANDBOX` (default
   `workspace`), `GROK_TIMEOUT_MS` (default 10 minutes).

   In the Discord Developer Portal, enable the **Message Content Intent** for
   the bot (Bot settings > Privileged Gateway Intents) — it's required to read
   message text.

3. Install dependencies:
   ```
   npm install
   ```
4. Deploy slash commands:
   ```
   npm run deploy-commands
   ```
5. Run the bot:

   ```
   npm run dev    # development, with auto-reload
   npm run build && npm start   # production
   ```

   `systemctl restart sroc` only re-runs the existing `dist/` build. It does
   **not** git pull or compile TypeScript. Use `/deploy` (or `$deploy`) to
   pull, rebuild, and exit so systemd starts the new build.

   Or install the systemd unit from this checkout (edit paths in `sroc.service`
   first if the repo is not `/root/sroc`):

   ```
   ln -s /root/sroc/sroc.service /etc/systemd/system/sroc.service
   systemctl daemon-reload
   systemctl enable --now sroc
   ```

   Logs: `journalctl -u sroc -f`. After the unit is running, `/deploy` pulls,
   rebuilds, and restarts. A bare `systemctl restart sroc` does not pick up
   source changes.

The bot only responds in the guild configured via `DISCORD_GUILD_ID`, and in
DMs with `OWNER_ID`. Other DMs are ignored.

Each conversation runs Grok inside a **Docker container** (`sroc-ws-<id>`).
The workspace starts **empty** so a greeting does not clone the repo or
explore the codebase. If you ask it to work on files or open a PR, it clones
`GROK_REPO_URL` itself. The live bot checkout, `.env`, and SQLite DB are not
mounted. Throw a conversation away with `/isolate prune` (owner only).
Build the image once: `npm run build-image`. Set `GROK_ISOLATE_CLONE=true`
only if you want every new conversation to clone up front (slow).

`GITHUB_TOKEN` authenticates `git` and `gh` inside the container (the bot
GitHub account). The agent can clone a repo, push a branch, and `gh pr create`.

To make commits appear under your GitHub account **as "Bopke"** (with the green "verified" badge),
the bot now defaults to:

- `GIT_USER_NAME=Bopke`
- `GIT_USER_EMAIL=bot@bopke.dev`

You can still override via environment variables. This sets both `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars (used by Grok Build) and `git config user.name/email` inside containers.
Do not pass `DISCORD_TOKEN` into containers.

## Chatting with the bot

- **@mention the bot** in a guild message to start a new Grok Build session.
- **Reply to one of the bot's messages** to continue that session. Anyone in the
  guild can reply; if multiple people reply to the same bot message, each reply
  forks a new session that shares history up to that point.
- **DMs with the owner** (`OWNER_ID`) are also handled. A normal DM continues
  the latest session in that DM; @mention the bot there to start a new one.
  Everyone else's DMs get no response. Guild and DM `/systemprompt` stores are
  separate.
- Discord message ids and Grok session ids are stored in `data/bot.db`
  (SQLite, gitignored). Conversation history itself lives in Grok Build sessions.
- Ask it to inspect or change code — that happens in the conversation's
  container, not on the host. If a turn takes more than 10 seconds it posts
  `-# Working...` (including the current tool); faster replies skip that.

## Deploy

- `/deploy` — `git pull --ff-only`, `npm run build`, register slash commands,
  then exit so systemd (`Restart=always`) starts the new `dist/`. Also `$deploy`.
  The deploy reply is deleted 10 seconds after the new process is up.
- `/isolate status` / `/isolate prune` — list or destroy conversation containers
  (owner only).

## System prompt

- `/systemprompt view` — show the current system prompt.
- `/systemprompt set <text>` — change it. Only affects conversations started afterward;
  conversations already in progress keep using the prompt that was active when they started.
- `/systemprompt history [count]` — list recent changes and who made them.

The Discord system prompt is passed to Grok Build as extra `--rules` on new
sessions (it does not replace the coding-agent prompt). If none has ever been
set, the bot still runs with the default Discord/coding rules above.

## Text commands (`$` prefix)

Every command also works as a plain text message prefixed with `$`, e.g. `$systemprompt set <text>`
or `$ping` — useful when slash commands aren't convenient. Text-command replies are always
posted as normal, visible channel messages (Discord doesn't support hiding replies to plain
messages the way it does for slash command responses).

## Adding commands

Add a new file under `src/commands/`, export a `Command` (see `src/commands/ping.ts` for an
example) implementing both `execute` (slash) and `runText` (`$prefix`), and register it in
`src/commands/index.ts`. Re-run `npm run deploy-commands` after adding or changing commands.

## Testing

`npm test` runs unit tests (Node's built-in test runner) covering conversation
routing and the Grok Build CLI argument/stream helpers.
