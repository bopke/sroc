import type { ChatInputCommandInteraction, Message } from "discord.js";

export const DISCORD_MESSAGE_LIMIT = 2000;

export interface PostedMessage {
  channelId: string;
  messageId: string;
  content: string;
}

export function splitMessage(content: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
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

/** Reply to `source`, then reply to each previous chunk so Discord shows a chain. */
export async function replyMessageSplit(
  source: Message,
  content: string,
  opts?: { existing?: Message | null },
): Promise<PostedMessage[]> {
  const chunks = splitMessage(content);
  const posted: PostedMessage[] = [];
  let last: Message | null = opts?.existing ?? null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i === 0 && last) {
      last = await last.edit(chunk);
    } else if (!last) {
      last = await source.reply(chunk);
    } else {
      last = await last.reply(chunk);
    }
    posted.push({ channelId: last.channelId, messageId: last.id, content: chunk });
  }
  return posted;
}

export async function replyInteractionSplit(
  interaction: ChatInputCommandInteraction,
  content: string,
  opts?: { ephemeral?: boolean },
): Promise<PostedMessage[]> {
  const chunks = splitMessage(content);
  const ephemeral = opts?.ephemeral ?? false;
  const posted: PostedMessage[] = [];

  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: chunks[0], ephemeral });
  } else {
    await interaction.editReply({ content: chunks[0] });
  }
  const first = await interaction.fetchReply();
  posted.push({ channelId: first.channelId, messageId: first.id, content: chunks[0] });

  for (const chunk of chunks.slice(1)) {
    const extra = await interaction.followUp({ content: chunk, ephemeral });
    posted.push({ channelId: extra.channelId, messageId: extra.id, content: chunk });
  }
  return posted;
}
