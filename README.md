# sroc

A Discord bot written in TypeScript using [discord.js](https://discord.js.org/), backed by
xAI's Grok API for chat and the ability to change its system prompt on demand.

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials:
   ```
   DISCORD_TOKEN=
   DISCORD_CLIENT_ID=
   DISCORD_GUILD_ID=      # required — the single guild the bot operates in
   GROK_API_KEY=
   GROK_MODEL=grok-3      # optional, defaults to grok-3
   ```
   In the Discord Developer Portal, enable the **Message Content Intent** for
   the bot (Bot settings > Privileged Gateway Intents) — it's required to read
   message text.
2. Install dependencies:
   ```
   npm install
   ```
3. Deploy slash commands:
   ```
   npm run deploy-commands
   ```
4. Run the bot:
   ```
   npm run dev    # development, with auto-reload
   npm run build && npm start   # production
   ```

The bot only responds in the guild configured via `DISCORD_GUILD_ID` and never in DMs.

## Chatting with the bot

- **@mention the bot** in a message to start a new conversation.
- **Reply to one of the bot's messages** to continue that conversation — the bot remembers
  prior turns. Anyone can reply to continue a thread; if multiple people reply to the same
  bot message, the conversation branches into separate threads that share the history up to
  that point.
- Conversation history and a rolling summary of older turns are stored locally in
  `data/bot.db` (SQLite, gitignored).

## System prompt

- `/systemprompt view` — show the current system prompt.
- `/systemprompt set <text>` — change it. Only affects conversations started afterward;
  conversations already in progress keep using the prompt that was active when they started.
- `/systemprompt history [count]` — list recent changes and who made them.

If no system prompt has ever been set, the bot runs without one.

## Adding commands

Add a new file under `src/commands/`, export a `Command` (see `src/commands/ping.ts` for an example), and register it in `src/commands/index.ts`. Re-run `npm run deploy-commands` after adding or changing commands.

## Testing

`npm test` runs unit tests (Node's built-in test runner) covering the conversation
context-building and summary-folding logic in `src/conversation.ts`.
