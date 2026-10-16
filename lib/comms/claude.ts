/**
 * One small door to Claude for the Inbox: a system prompt, a user text, and a tool whose input is the
 * answer. Same key and model as the receipt reader (ANTHROPIC_API_KEY · CLAUDE_MODEL).
 */

const API = "https://api.anthropic.com/v1/messages";

export const ASSOCIATION = "a small Swedish nonprofit — an art association teaching Korean folk painting (minhwa) in Stockholm. " +
  "It runs weekly painting sessions members book in an app (seats, waiting list, monthly passes), sells painting material to members, " +
  "takes part in fairs and school projects, and answers the public on Instagram and by e-mail (Swedish, English, Korean).";

export async function askTool<T extends Record<string, unknown>>(opts: {
  system: string;
  user: string;
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
  maxTokens?: number;
}): Promise<{ input: T | null; note: string | null }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { input: null, note: "ANTHROPIC_API_KEY is not set" };
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: opts.maxTokens ?? 1200,
      system: opts.system,
      tools: [opts.tool],
      tool_choice: { type: "tool", name: opts.tool.name },
      messages: [{ role: "user", content: [{ type: "text", text: opts.user }] }],
    }),
  });
  if (!res.ok) return { input: null, note: `Claude API ${res.status}` };
  const data = (await res.json()) as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
  const call = data.content?.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
  if (!call?.input) return { input: null, note: "no answer" };
  return { input: call.input as T, note: null };
}

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
