import { Client, Collection, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";
import type { Command } from "./types.js";
import { db, getCurrentSystemPrompt, insertMessage } from "./db.js";
import { chat, summarize, type ChatMessage } from "./grok.js";
import { isTrackedAssistantMessage, prepareReplyContext, stripBotMention } from "./conversation.js";
import { formatIncomingContent } from "./discordContext.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commandsByName = new Collection<string, Command>();
for (const command of commands) {
  commandsByName.set(command.data.name, command);
}

const COMMAND_PREFIX = "$";
const DISCORD_MESSAGE_LIMIT = 2000;

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

function channelContextMessage(channelName: string | undefined): ChatMessage {
  return {
    role: "system",
    content: `You are replying in the #${channelName ?? "unknown"} channel.`,
  };
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

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
  if (!message.guild || message.guild.id !== config.guildId) return;
  if (!message.channel.isSendable()) return;
  if (!client.user) return;

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

  const repliedToId = message.reference?.messageId;
  let parentMessageId: string | null;

  if (repliedToId && isTrackedAssistantMessage(db, repliedToId)) {
    parentMessageId = repliedToId;
  } else if (message.mentions.has(client.user)) {
    parentMessageId = null;
  } else {
    return;
  }

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

  try {
    const context = await prepareReplyContext(db, parentMessageId, summarize);
    const channelName = message.guild.channels.cache.get(message.channelId)?.name;

    await message.channel.sendTyping().catch(() => undefined);

    const replyText = await chat(context.systemPrompt, [
      channelContextMessage(channelName),
      ...context.contextMessages,
      { role: "user", content },
    ]);

    insertMessage(db, {
      message_id: message.id,
      parent_message_id: parentMessageId,
      channel_id: message.channelId,
      author_id: message.author.id,
      role: "user",
      content,
      summary: null,
      system_prompt_id:
        parentMessageId === null ? (getCurrentSystemPrompt(db)?.id ?? null) : null,
    });

    const chunks = splitMessage(replyText);
    let lastSentId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) {
        const sent = await message.reply(chunks[i]);
        lastSentId = sent.id;
      } else {
        const sent = await message.channel.send(chunks[i]);
        lastSentId = sent.id;
      }
    }

    insertMessage(db, {
      message_id: lastSentId!,
      parent_message_id: message.id,
      channel_id: message.channelId,
      author_id: client.user.id,
      role: "assistant",
      content: replyText,
      summary: null,
      system_prompt_id: null,
    });
  } catch (error) {
    console.error("Failed to handle chat message:", error);
    await message
      .reply("Sorry, I couldn't get a response from Grok just now. Please try again.")
      .catch(() => undefined);
  }
});

client.login(config.token);
