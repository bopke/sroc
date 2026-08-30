import { Client, Collection, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";
import type { Command } from "./types.js";
import { db, getCurrentSystemPrompt, insertMessage, promptScope } from "./db.js";
import { GrokBuildClient, type GrokStreamEvent } from "./grok.js";
import {
  buildSessionRules,
  isAllowedSource,
  resolveChatTarget,
  stripBotMention,
} from "./conversation.js";
import { formatIncomingContent } from "./discordContext.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const grok = new GrokBuildClient({
  bin: config.grokBin,
  model: config.grokModel,
  cwd: config.grokCwd,
  apiKey: config.grokApiKey,
  alwaysApprove: config.grokAlwaysApprove,
  sandbox: config.grokSandbox,
  timeoutMs: config.grokTimeoutMs,
});

const commandsByName = new Collection<string, Command>();
for (const command of commands) {
  commandsByName.set(command.data.name, command);
}

const COMMAND_PREFIX = "$";
const DISCORD_MESSAGE_LIMIT = 2000;
const TYPING_INTERVAL_MS = 8000;
const STATUS_EDIT_INTERVAL_MS = 2000;

function splitMessage(content: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (content.length <= limit) return [content];

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function toolStatusText(event: GrokStreamEvent): string | null {
  if (event.type !== "tool_call") return null;
  const label = event.title ?? event.toolName;
  return label ? `-# Working... ${label}` : "-# Working...";
}

async function deliverReply(status: Message, replyText: string): Promise<string> {
  const chunks = splitMessage(replyText);
  await status.edit(chunks[0]);
  let lastSentId = status.id;
  const channel = status.channel;
  if (!channel.isSendable()) return lastSentId;
  for (let i = 1; i < chunks.length; i++) {
    const sent = await channel.send(chunks[i]);
    lastSentId = sent.id;
  }
  return lastSentId;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Grok Build workspace: ${config.grokCwd} (model ${config.grokModel})`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (
    !isAllowedSource({
      guildId: interaction.guildId,
      authorId: interaction.user.id,
      configuredGuildId: config.guildId,
      ownerId: config.ownerId,
    })
  ) {
    return;
  }

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    console.warn(`No handler for command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing command ${interaction.commandName}:`, error);
    const reply = { content: "There was an error executing this command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (
    !isAllowedSource({
      guildId: message.guildId,
      authorId: message.author.id,
      configuredGuildId: config.guildId,
      ownerId: config.ownerId,
    })
  ) {
    return;
  }
  if (!message.channel.isSendable()) return;
  if (!client.user) return;

  const isDm = !message.guild;

  if (message.content.startsWith(COMMAND_PREFIX)) {
    const [token, ...args] = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const command = token ? commandsByName.get(token.toLowerCase()) : undefined;
    if (command) {
      try {
        await command.runText(message, args);
      } catch (error) {
        console.error(`Error running text command ${token}:`, error);
        await message.reply("There was an error executing this command.").catch(() => undefined);
      }
      return;
    }
  }

  const target = resolveChatTarget(db, {
    repliedToId: message.reference?.messageId,
    mentionedBot: message.mentions.has(client.user),
    isDm,
    channelId: message.channelId,
  });
  if (!target) return;

  const { parentMessageId, resumeSessionId } = target;

  const strippedText = stripBotMention(message.content, client.user.id);
  if (!strippedText && message.attachments.size === 0 && message.embeds.length === 0) return;

  const content = formatIncomingContent(
    {
      author: message.author,
      member: message.member,
      attachments: message.attachments.values(),
      embeds: message.embeds,
    },
    strippedText,
  );

  const scope = promptScope(message.guildId);
  const channelName = message.guild?.channels.cache.get(message.channelId)?.name;
  const isNewSession = !resumeSessionId;
  const rules = isNewSession
    ? buildSessionRules(getCurrentSystemPrompt(db, scope)?.content ?? null, channelName, {
        dm: isDm,
      })
    : null;

  const status = await message.reply("-# Working...");
  const typing = setInterval(() => {
    message.channel.sendTyping().catch(() => undefined);
  }, TYPING_INTERVAL_MS);
  await message.channel.sendTyping().catch(() => undefined);

  let lastStatusEdit = 0;
  const onEvent = (event: GrokStreamEvent) => {
    const text = toolStatusText(event);
    if (!text) return;
    const now = Date.now();
    if (now - lastStatusEdit < STATUS_EDIT_INTERVAL_MS) return;
    lastStatusEdit = now;
    status.edit(text).catch(() => undefined);
  };

  try {
    const result = await grok.prompt({
      prompt: content,
      resumeSessionId,
      fork: Boolean(resumeSessionId),
      rules,
      onEvent,
    });

    insertMessage(db, {
      message_id: message.id,
      parent_message_id: parentMessageId,
      channel_id: message.channelId,
      author_id: message.author.id,
      role: "user",
      content,
      summary: null,
      system_prompt_id:
        parentMessageId === null ? (getCurrentSystemPrompt(db, scope)?.id ?? null) : null,
      grok_session_id: null,
    });

    const lastSentId = await deliverReply(status, result.text);

    insertMessage(db, {
      message_id: lastSentId,
      parent_message_id: message.id,
      channel_id: message.channelId,
      author_id: client.user.id,
      role: "assistant",
      content: result.text,
      summary: null,
      system_prompt_id: null,
      grok_session_id: result.sessionId,
    });
  } catch (error) {
    console.error("Failed to handle chat message:", error);
    await status
      .edit("Sorry, I couldn't get a response from Grok just now. Please try again.")
      .catch(() => undefined);
  } finally {
    clearInterval(typing);
  }
});

client.login(config.token);
