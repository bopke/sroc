import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({
  apiKey: config.grokApiKey,
  baseURL: "https://api.x.ai/v1",
});

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(
  systemPrompt: string | null,
  messages: ChatMessage[],
): Promise<string> {
  const fullMessages: ChatMessage[] = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;

  const response = await client.chat.completions.create({
    model: config.grokModel,
    messages: fullMessages,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Grok returned an empty response");
  }
  return content;
}

const SUMMARIZE_INSTRUCTION =
  "You maintain a running summary of an ongoing conversation. " +
  "Given the previous summary (if any) and the next messages that occurred after it, " +
  "produce a single updated, concise summary covering everything. " +
  "Write it as plain prose, third person, capturing key facts, decisions, and context " +
  "a participant would need to understand the conversation so far. Do not add commentary.";

export async function summarize(
  existingSummary: string | null,
  messages: ChatMessage[],
): Promise<string> {
  const parts: string[] = [];
  if (existingSummary) {
    parts.push(`Previous summary:\n${existingSummary}`);
  }
  parts.push(
    "Messages since then:\n" +
      messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
  );

  return chat(SUMMARIZE_INSTRUCTION, [{ role: "user", content: parts.join("\n\n") }]);
}
