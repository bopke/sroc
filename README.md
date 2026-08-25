# sroc

A Discord bot written in TypeScript using [discord.js](https://discord.js.org/).

## Setup

1. Copy `.env.example` to `.env` and fill in your bot's credentials:
   ```
   DISCORD_TOKEN=
   DISCORD_CLIENT_ID=
   DISCORD_GUILD_ID=   # optional, for instant guild-scoped command deploys during development
   ```
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

## Adding commands

Add a new file under `src/commands/`, export a `Command` (see `src/commands/ping.ts` for an example), and register it in `src/commands/index.ts`. Re-run `npm run deploy-commands` after adding or changing commands.
