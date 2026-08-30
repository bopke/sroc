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
   XAI_API_KEY=           # from https://console.x.ai (GROK_API_KEY still accepted)
   GROK_MODEL=grok-build  # optional, defaults to grok-build
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

   Or install the systemd unit from this checkout (edit paths in `sroc.service`
   first if the repo is not `/root/sroc`):
   ```
   ln -s /root/sroc/sroc.service /etc/systemd/system/sroc.service
   systemctl daemon-reload
   systemctl enable --now sroc
   ```
   Logs: `journalctl -u sroc -f`. Rebuild with `npm run build` after code
   changes, then `systemctl restart sroc`.

The bot only responds in the guild configured via `DISCORD_GUILD_ID` and never in DMs.

`GROK_ALWAYS_APPROVE=true` means the agent can run tools (read/edit/run) without
asking. The default `GROK_SANDBOX=workspace` still limits writes to the working
directory. Point `GROK_CWD` at the repo you want it to work in.

## Chatting with the bot

- **@mention the bot** in a message to start a new Grok Build session.
- **Reply to one of the bot's messages** to continue that session. Anyone can
  reply; if multiple people reply to the same bot message, each reply forks a
  new session that shares history up to that point.
- Discord message ids and Grok session ids are stored in `data/bot.db`
  (SQLite, gitignored). Conversation history itself lives in Grok Build sessions.
- Ask it to inspect or change code in `GROK_CWD` — it has the same tools as
  headless `grok -p`. Long runs post a "Working…" status (including the current
  tool) until the reply is ready.

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
