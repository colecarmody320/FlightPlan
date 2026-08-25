import { CirrusProviderError } from "./providers/types.ts";

/* ============================================================
   REQUEST VALIDATION + LIMITS
   Deliberately free of Deno APIs so this can be unit-tested off the
   edge runtime. This is the boundary that decides what reaches the
   provider, so it is allowlist-shaped: unknown fields are dropped
   rather than forwarded.
   ============================================================ */

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_SYSTEM_PROMPT_CHARS = 8000;
export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARS = 12000;
export const MAX_REPLY_CHARS = 8000;

export const DEFAULT_MAX_OUTPUT_TOKENS = 800;
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
export const RATE_WINDOW_MS = 60_000;
export const MAX_ATTEMPTS = 2; // one initial try plus one conservative retry

/** Only these context keys may be forwarded. Anything else is dropped. */
const ALLOWED_CONTEXT_KEYS = ["selectedType", "selectedId", "activeTopic"];
const MAX_CONTEXT_VALUE_CHARS = 200;

export interface ChatRequest {
  message: string;
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  page?: string;
  structuredContext?: Record<string, string>;
}

const bad = (message: string) =>
  new CirrusProviderError("bad_request", message, { status: 400 });

export function validate(raw: unknown): ChatRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bad("Body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const message = body.message;
  if (typeof message !== "string" || !message.trim()) {
    throw bad("`message` must be a non-empty string");
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw bad(`\`message\` exceeds ${MAX_MESSAGE_CHARS} characters`);
  }

  const systemPrompt = body.systemPrompt;
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw bad("`systemPrompt` must be a non-empty string");
  }
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw bad(`\`systemPrompt\` exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters`);
  }

  const rawHistory = body.history ?? [];
  if (!Array.isArray(rawHistory)) throw bad("`history` must be an array");

  // Keep the most recent turns; stop once the character budget is spent.
  const history: ChatRequest["history"] = [];
  let historyChars = 0;
  for (const item of rawHistory.slice(-MAX_HISTORY_MESSAGES)) {
    if (typeof item !== "object" || item === null) continue;
    const { role, content } = item as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    if (!content.trim()) continue;
    if (historyChars + content.length > MAX_HISTORY_CHARS) break;
    historyChars += content.length;
    history.push({ role, content });
  }

  const page = typeof body.page === "string" ? body.page.slice(0, 64) : undefined;

  let structuredContext: Record<string, string> | undefined;
  if (body.structuredContext !== undefined) {
    const ctx = body.structuredContext;
    if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) {
      throw bad("`structuredContext` must be an object");
    }
    const source = ctx as Record<string, unknown>;
    const cleaned: Record<string, string> = {};
    for (const key of ALLOWED_CONTEXT_KEYS) {
      const value = source[key];
      // Strings only: this is what stops a nested slab of app state
      // from riding along inside the context object.
      if (typeof value === "string" && value) {
        cleaned[key] = value.slice(0, MAX_CONTEXT_VALUE_CHARS);
      }
    }
    if (Object.keys(cleaned).length) structuredContext = cleaned;
  }

  return { message: message.trim(), systemPrompt, history, page, structuredContext };
}
