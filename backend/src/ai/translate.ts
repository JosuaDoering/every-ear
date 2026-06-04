import { loadAiConfig } from "./config.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function systemPrompt(sourceName: string, targetName: string): string {
  return (
    `You are a professional simultaneous interpreter. Translate the user's text ` +
    `from ${sourceName} into ${targetName}. Output only the translation — no notes, ` +
    `no quotes, no source text. Preserve tone and meaning; keep it natural and concise.`
  );
}

export type TranslateError = { status: number; message: string };

/**
 * Stream a translation from OpenRouter (OpenAI-compatible SSE). `onDelta` fires
 * for each incremental token; the resolved value is the full translation.
 * `context` holds the last few prior translations for this target (continuity).
 */
export async function translateStream(
  text: string,
  sourceName: string,
  targetName: string,
  context: string[],
  onDelta: (full: string) => void,
): Promise<string> {
  const cfg = await loadAiConfig();
  if (!cfg.openRouterApiKey || !cfg.model) {
    throw { status: 400, message: "OpenRouter API key or model not configured" } satisfies TranslateError;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(sourceName, targetName) },
  ];
  if (context.length > 0) {
    messages.push({
      role: "assistant",
      content: `Previous translations for continuity:\n${context.join("\n")}`,
    });
  }
  messages.push({ role: "user", content: text });

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: cfg.temperature,
      max_tokens: 1024,
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw { status: 502, message: `OpenRouter error ${res.status}: ${body.slice(0, 200)}` } satisfies TranslateError;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        const piece = parsed.choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          onDelta(full);
        }
      } catch {
        // Ignore keep-alive/comment lines and partial JSON.
      }
    }
  }

  return full;
}
