import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Sticker,
  type User,
} from "discord.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { isAlreadyPostedToValut, markAsPostedToValut } from "./db.js";
import { commands } from "./commands/index.js";
import type { Command } from "./types.js";
import {
  db,
  getCurrentSystemPrompt,
  getWorkspaceId,
  insertMessage,
  promptScope,
  takeDeployNotice,
} from "./db.js";
import { replyMessageSplit } from "./discordReply.js";
import { GrokBuildClient, type GrokStreamEvent } from "./grok.js";
import {
  buildSessionRules,
  isAllowedSource,
  resolveChatTarget,
  stripBotMention,
} from "./conversation.js";
import { formatIncomingContent } from "./discordContext.js";
import { createGrokAuth } from "./grok-auth.js";
import { dockerBridgeAddress, startGithubProxy, startXaiProxy } from "./secret-proxy.js";

const grokAuth = createGrokAuth({
  grokHome: process.env.GROK_HOME ?? join(homedir(), ".grok"),
  apiKey: config.grokApiKey,
});
if (!grokAuth.hasAny()) {
  throw new Error(
    "No Grok credential. Run `grok login` on this host (SuperGrok) or set XAI_API_KEY.",
  );
}
console.log(`Grok credential: ${grokAuth.label()}`);

const dockerGw = dockerBridgeAddress();
const xaiProxy = await startXaiProxy({
  bindHost: dockerGw,
  getBearer: () => grokAuth.getBearer(),
});
const githubProxy = config.githubToken
  ? await startGithubProxy({ bindHost: dockerGw, bearerToken: config.githubToken })
  : undefined;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

const grok = new GrokBuildClient({
  bin: config.grokBin,
  model: config.grokModel,
  cwd: config.grokCwd,
  apiKey: config.grokApiKey,
  githubToken: config.githubToken,
  alwaysApprove: config.grokAlwaysApprove,
  sandbox: config.grokSandbox,
  timeoutMs: config.grokTimeoutMs,
  isolate: config.grokIsolate,
  isolateSettings: {
    image: config.grokIsolateImage,
    repoUrl: config.grokRepoUrl,
    gitUserName: config.gitUserName,
    gitUserEmail: config.gitUserEmail,
    memory: config.grokIsolateMemory,
    cpus: config.grokIsolateCpus,
    pidsLimit: 256,
    cloneRepo: config.grokIsolateClone,
    xaiProxyUrl: `http://host.docker.internal:${xaiProxy.port}`,
    githubProxyUrl: githubProxy ? `http://host.docker.internal:${githubProxy.port}` : undefined,
  },
  noPlan: config.grokNoPlan,
  noSubagents: config.grokNoSubagents,
  effort: config.grokEffort,
});

const commandsByName = new Collection<string, Command>();
for (const command of commands) {
  commandsByName.set(command.data.name, command);
}

const COMMAND_PREFIX = "$";
const TYPING_INTERVAL_MS = 8000;
const STATUS_EDIT_INTERVAL_MS = 2000;
const WORKING_DELAY_MS = 10_000;
const DEPLOY_NOTICE_DELETE_MS = 10_000;

function toolStatusText(event: GrokStreamEvent): string | null {
  if (event.type === "thought") return "-# Working...";
  if (event.type !== "tool_call") return null;
  const label = event.title ?? event.toolName;
  return label ? `-# Working... ${label}` : "-# Working...";
}

async function deliverReply(
  userMessage: Message,
  status: Message | null,
  replyText: string,
): Promise<{ messageId: string; content: string }[]> {
  if (status) {
    await status.delete().catch(() => undefined);
  }
  const posted = await replyMessageSplit(userMessage, replyText);
  return posted.map((item) => ({ messageId: item.messageId, content: item.content }));
}

function startWorkingStatus(userMessage: Message): {
  onEvent: (event: GrokStreamEvent) => void;
  getStatus: () => Message | null;
  stop: () => void;
} {
  const startedAt = Date.now();
  let status: Message | null = null;
  let pending = "-# Working...";
  let lastEdit = 0;
  let cancelled = false;

  const postOrEdit = async (text: string) => {
    if (cancelled) return;
    pending = text;
    if (!status) {
      const sent = await userMessage.reply(text).catch(() => null);
      if (cancelled) {
        await sent?.delete().catch(() => undefined);
        return;
      }
      status = sent;
      lastEdit = Date.now();
      return;
    }
    const now = Date.now();
    if (now - lastEdit < STATUS_EDIT_INTERVAL_MS) return;
    lastEdit = now;
    await status.edit(text).catch(() => undefined);
  };

  const timer = setTimeout(() => {
    void postOrEdit(pending);
  }, WORKING_DELAY_MS);

  return {
    onEvent(event) {
      const text = toolStatusText(event);
      if (!text) return;
      pending = text;
      if (Date.now() - startedAt < WORKING_DELAY_MS) return;
      void postOrEdit(text);
    },
    getStatus: () => status,
    stop() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}

async function deleteStoredDeployNotice(): Promise<void> {
  const notice = takeDeployNotice(db);
  if (!notice) return;
  try {
    const channel = await client.channels.fetch(notice.channel_id);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return;
    for (const messageId of notice.message_ids) {
      try {
        const posted = await channel.messages.fetch(messageId);
        await posted.delete();
      } catch (error) {
        console.error(`Failed to delete deploy notice ${messageId}:`, error);
      }
    }
  } catch (error) {
    console.error("Failed to delete deploy notice:", error);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log("Hello world from SROC bot - kod się uruchomił");
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Grok Build workspace: ${config.grokCwd} (model ${config.grokModel})`);
  setTimeout(() => {
    void deleteStoredDeployNotice();
  }, DEPLOY_NOTICE_DELETE_MS);
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
        await replyMessageSplit(message, "There was an error executing this command.").catch(
          () => undefined,
        );
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
  const workspaceId = getWorkspaceId(db, parentMessageId) ?? message.id;

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
        repoUrl: config.grokRepoUrl,
        githubConfigured: Boolean(config.githubToken),
      })
    : null;

  const typing = setInterval(() => {
    message.channel.sendTyping().catch(() => undefined);
  }, TYPING_INTERVAL_MS);
  await message.channel.sendTyping().catch(() => undefined);

  const working = startWorkingStatus(message);

  try {
    const result = await grok.prompt({
      prompt: content,
      resumeSessionId,
      fork: Boolean(resumeSessionId),
      rules,
      workspaceId,
      onEvent: working.onEvent,
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
      workspace_id: workspaceId,
    });

    working.stop();
    const sent = await deliverReply(message, working.getStatus(), result.text);

    for (const chunk of sent) {
      insertMessage(db, {
        message_id: chunk.messageId,
        parent_message_id: message.id,
        channel_id: message.channelId,
        author_id: client.user.id,
        role: "assistant",
        content: chunk.content,
        summary: null,
        system_prompt_id: null,
        grok_session_id: result.sessionId,
        workspace_id: workspaceId,
      });
    }
  } catch (error) {
    console.error("Failed to handle chat message:", error);
    working.stop();
    const apology = "Sorry, I couldn't get a response from Grok just now. Please try again.";
    const status = working.getStatus();
    if (status) {
      await status.delete().catch(() => undefined);
    }
    await replyMessageSplit(message, apology).catch(() => undefined);
  } finally {
    working.stop();
    clearInterval(typing);
  }
});

async function handleGoldReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
) {
  if (!config.valutChannelId) return;

  // Fetch full objects if partial
  if (reaction.partial) {
    try {
      reaction = await reaction.fetch();
    } catch (error) {
      console.error("Failed to fetch reaction:", error);
      return;
    }
  }
  if (user.partial) {
    try {
      user = await user.fetch();
    } catch (error) {
      console.error("Failed to fetch user:", error);
      return;
    }
  }

  const emojiName = reaction.emoji.name?.toLowerCase() || "";
  if (!emojiName.includes("gold")) return;

  const message = reaction.message;
  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return;
    }
  }

  // Only react to own messages (bot's or user's own in the guild)
  if (!message.author || (message.author.id !== client.user?.id && message.author.id !== user.id)) {
    return;
  }

  if (isAlreadyPostedToValut(db, message.id)) {
    console.log(`Message ${message.id} already posted to valut`);
    return;
  }

  const count = reaction.count ?? 0;
  if (count < 3) return;

  console.log(`Gold reaction detected on message ${message.id} (${count} reactions)`);

  try {
    const valutChannel = await client.channels.fetch(config.valutChannelId);
    if (!valutChannel?.isTextBased()) {
      console.error("VALUT_CHANNEL_ID is not a text channel");
      return;
    }

    if (!valutChannel.isSendable()) {
      console.error("VALUT_CHANNEL_ID is not sendable");
      return;
    }

    const posted = await valutChannel.send({
      content: message.content || undefined,
      embeds: message.embeds,
      files: message.attachments.map((a) => a.url),
      stickers: message.stickers.map((s: Sticker) => s.id),
      allowedMentions: { parse: [] },
    });

    markAsPostedToValut(db, message.id, message.channelId, posted.id);
    console.log(`Posted to valut: ${posted.id}`);
  } catch (error) {
    console.error("Failed to post to valut channel:", error);
  }
}

// Listen for reactions
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  void handleGoldReaction(reaction, user);
});

client.login(config.token);
