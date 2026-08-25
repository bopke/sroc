export interface FormattableAttachment {
  name: string;
  url: string;
}

export interface FormattableEmbed {
  title?: string | null;
  description?: string | null;
  url?: string | null;
}

export interface FormattableMessage {
  author: { username: string; displayName?: string };
  member?: { displayName: string } | null;
  attachments: Iterable<FormattableAttachment>;
  embeds: FormattableEmbed[];
}

/**
 * Renders an incoming Discord message as plain text for Grok, prefixed with
 * who sent it (server nickname if set, else global display name) and their
 * @username, since every human turn is otherwise indistinguishable as role
 * "user". Attachments and embeds are appended as text notes — filenames,
 * URLs, and embed title/description — not sent as actual file/image content.
 */
export function formatIncomingContent(message: FormattableMessage, text: string): string {
  const speaker = message.member?.displayName ?? message.author.displayName ?? message.author.username;

  const parts: string[] = [];
  if (text) parts.push(text);

  for (const attachment of message.attachments) {
    parts.push(`[Attachment: ${attachment.name}](${attachment.url})`);
  }

  for (const embed of message.embeds) {
    const label = embed.title ?? "Embed";
    const description = embed.description ? ` — ${embed.description}` : "";
    const url = embed.url ? ` (${embed.url})` : "";
    parts.push(`[${label}${description}]${url}`);
  }

  const body = parts.length > 0 ? parts.join("\n") : "(no content)";
  return `${speaker} (@${message.author.username}): ${body}`;
}
