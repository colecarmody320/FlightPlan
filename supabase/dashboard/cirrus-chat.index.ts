/* ============================================================
   CIRRUS CHAT — SINGLE-FILE BUILD FOR THE SUPABASE DASHBOARD

   Paste this whole file as `cirrus-chat/index.ts` in the Supabase
   dashboard. It is behaviourally identical to the multi-file version
   under supabase/functions/cirrus-chat/ — same auth, throttling,
   validation, provider abstraction, CORS, logging and data-safety
   rules — just inlined so it can be pasted without a CLI.

   Keep the two in sync when either changes.

   READ/CONVERSATION ONLY. No table access, no writes, no FlightPlan
   data touched. Every failure returns an error code and nothing else:
   no fallback content, no seed, no state rewrite.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.4";

/* ---------- limits ---------- */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_SYSTEM_PROMPT_CHARS = 24000; // personality + action catalogue + read-only app context
/* Beyond this the payload is not a prompt that got large; it is
   something else, and it is refused rather than trimmed. */
const MAX_SYSTEM_PROMPT_HARD_CHARS = 80000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 12000;
const MAX_REPLY_CHARS = 8000;

const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_RATE_LIMIT_PER_DAY = 500;
/* Longer than the provider timeout, so a lease only ever expires for a
   request that genuinely died rather than one still working. */
const CONCURRENCY_LEASE_SECONDS = 45;
const RATE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 2; // one initial try plus one conservative retry

const DEFAULT_PROVIDER = "gemini";
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** Only these context keys may be forwarded. Anything else is dropped. */
const ALLOWED_CONTEXT_KEYS = ["selectedType", "selectedId", "activeTopic"];
const MAX_CONTEXT_VALUE_CHARS = 200;

const ALLOWED_ORIGINS = [
  "https://colecarmody320.github.io",
  "http://localhost:5173",
  "http://localhost:5183",
];

/* ---------- errors ---------- */
type CirrusErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "rate_limited"
  | "daily_limit"
  | "busy"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_blocked"
  | "provider_error"
  | "malformed_provider_response"
  | "server_misconfigured"
  | "network_error"
  | "unknown";

class CirrusProviderError extends Error {
  code: CirrusErrorCode;
  status: number;
  retryable: boolean;
  providerStatus?: number;
  providerReason?: string;

  constructor(
    code: CirrusErrorCode,
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      providerStatus?: number;
      providerReason?: string;
    } = {},
  ) {
    super(message);
    this.name = "CirrusProviderError";
    this.code = code;
    this.status = opts.status ?? 502;
    this.retryable = opts.retryable ?? false;
    this.providerStatus = opts.providerStatus;
    this.providerReason = opts.providerReason;
  }
}

/* Trimmed, because a trailing newline pasted into the dashboard is
   invisible and has already cost this project a debugging session. */
const envStr = (name: string) => (Deno.env.get(name) ?? "").trim();

const envInt = (name: string, fallback: number) => {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/* ---------- request validation ---------- */
interface ChatRequest {
  message: string;
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  page?: string;
  structuredContext?: Record<string, string>;
}

const bad = (message: string) =>
  new CirrusProviderError("bad_request", message, { status: 400 });

function validate(raw: unknown): ChatRequest {
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

  let systemPrompt = body.systemPrompt;
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw bad("`systemPrompt` must be a non-empty string");
  }
  /* The system prompt carries read-only app context, whose size varies
     with how much data the user has. Refusing the whole turn because
     they own a lot of flashcards would be a poor trade, so this is
     trimmed rather than rejected — but only up to a point: past the
     hard ceiling the payload is not plausibly a prompt and is refused
     outright, before any provider call. */
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_HARD_CHARS) {
    throw bad(`\`systemPrompt\` exceeds ${MAX_SYSTEM_PROMPT_HARD_CHARS} characters`);
  }
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    systemPrompt = `${systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS)}\n[context truncated]`;
  }

  const rawHistory = body.history ?? [];
  if (!Array.isArray(rawHistory)) throw bad("`history` must be an array");

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
      if (typeof value === "string" && value) {
        cleaned[key] = value.slice(0, MAX_CONTEXT_VALUE_CHARS);
      }
    }
    if (Object.keys(cleaned).length) structuredContext = cleaned;
  }

  return { message: message.trim(), systemPrompt, history, page, structuredContext };
}

/* ---------- provider abstraction ---------- */
interface CirrusProviderRequest {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

interface CirrusProviderResult {
  reply: string;
  model: string;
  finishReason?: string;
}

interface CirrusProvider {
  readonly name: string;
  readonly model: string;
  generate(req: CirrusProviderRequest): Promise<CirrusProviderResult>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: {
    message?: string;
    status?: string;
    details?: Array<{ reason?: string }>;
  };
}

function createGeminiProvider(rawApiKey: string, rawModel: string): CirrusProvider {
  // Values pasted through a dashboard commonly pick up a trailing
  // newline or space. For the key Google answers API_KEY_INVALID; for
  // the model the whitespace is percent-encoded into the request URL
  // and comes back as "unexpected model name format". Both are opaque
  // 400s, so normalize both before use.
  const apiKey = (rawApiKey || "").trim();
  // Accept either "gemini-2.5-flash" or the fully-qualified
  // "models/gemini-2.5-flash"; the prefix is added by the endpoint.
  const model = (rawModel || "").trim().replace(/^models\//, "");

  if (!apiKey) {
    throw new CirrusProviderError(
      "server_misconfigured",
      "GEMINI_API_KEY is not set",
      { status: 500 },
    );
  }

  if (!model) {
    throw new CirrusProviderError(
      "server_misconfigured",
      "No Gemini model configured",
      { status: 500 },
    );
  }

  return {
    name: "gemini",
    model,

    async generate(req: CirrusProviderRequest): Promise<CirrusProviderResult> {
      // Gemini requires the first turn to be "user" and rejects a
      // conversation that opens on a model turn. Trimming history to the
      // most recent N can leave a leading assistant turn, so drop those.
      const history = [...req.history];
      while (history.length && history[0].role === "assistant") history.shift();

      // Gemini calls the assistant role "model".
      const contents = [
        ...history.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        { role: "user", parts: [{ text: req.message }] },
      ];

      const body = {
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens,
          temperature: 0.7,
        },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);

      let res: Response;
      try {
        res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          // Key travels in a header, not the URL, so it cannot leak
          // through redirect or error-URL logging.
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        throw new CirrusProviderError(
          aborted ? "provider_timeout" : "network_error",
          aborted
            ? `Gemini did not respond within ${req.timeoutMs}ms`
            : "Could not reach the Gemini API",
          { status: aborted ? 504 : 502, retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // Google's status ("INVALID_ARGUMENT") is broad; the useful part
        // is `details[].reason` ("API_KEY_INVALID"). Both are structural
        // metadata, never credentials or conversation content.
        let gStatus = "";
        let gReason = "";
        let gMessage = "";
        try {
          const errBody = (await res.json()) as GeminiResponse;
          gStatus = errBody?.error?.status || "";
          gReason =
            (errBody?.error?.details || [])
              .map((d) => d?.reason)
              .find((r): r is string => Boolean(r)) || "";
          // error.message is the only field that says *what* was wrong
          // with a rejected payload ("Unknown name X: Cannot find
          // field"). Google names the offending field, not its value.
          gMessage = (errBody?.error?.message || "").slice(0, 300);
        } catch {
          /* body wasn't JSON — status alone is enough */
        }
        const label = [gStatus, gReason, gMessage].filter(Boolean).join(": ");
        const meta = { providerStatus: res.status, providerReason: gReason || gStatus };

        // Shape of what we sent, so a rejected payload can be compared
        // against the schema. Counts and field names only — no prompt
        // text, no message text, no credentials.
        console.log(
          JSON.stringify({
            event: "gemini_request_shape",
            model,
            bodyKeys: Object.keys(body),
            contentsCount: contents.length,
            firstRole: contents[0]?.role,
            roles: contents.map((c) => c.role),
            hasSystemInstruction: Boolean(req.systemPrompt),
            systemPromptChars: req.systemPrompt.length,
            messageChars: req.message.length,
            generationConfig: body.generationConfig,
          }),
        );

        if (res.status === 429) {
          throw new CirrusProviderError(
            "provider_rate_limited",
            "Gemini rate limit or quota exceeded",
            { status: 429, retryable: true, ...meta },
          );
        }
        // A rejected key arrives as 401/403, or as a 400 carrying
        // API_KEY_INVALID. All three are configuration problems, not
        // provider outages, and must not be retried.
        const badKey =
          res.status === 401 ||
          res.status === 403 ||
          gReason === "API_KEY_INVALID" ||
          gReason === "API_KEY_SERVICE_BLOCKED";
        if (badKey) {
          throw new CirrusProviderError(
            "server_misconfigured",
            `Gemini rejected the configured credentials (${label || res.status})`,
            { status: 500, retryable: false, ...meta },
          );
        }
        if (res.status >= 500) {
          throw new CirrusProviderError("provider_error", `Gemini returned ${res.status}`, {
            status: 502,
            retryable: true,
            ...meta,
          });
        }
        throw new CirrusProviderError(
          "provider_error",
          `Gemini returned ${res.status}${label ? ` (${label})` : ""}`,
          { status: 502, retryable: false, ...meta },
        );
      }

      let parsed: GeminiResponse;
      try {
        parsed = (await res.json()) as GeminiResponse;
      } catch {
        throw new CirrusProviderError(
          "malformed_provider_response",
          "Gemini returned a body that was not valid JSON",
          { status: 502 },
        );
      }

      if (parsed.promptFeedback?.blockReason) {
        throw new CirrusProviderError(
          "provider_blocked",
          `Gemini declined to answer (${parsed.promptFeedback.blockReason})`,
          { status: 422, retryable: false },
        );
      }

      const candidate = parsed.candidates?.[0];
      const reply = (candidate?.content?.parts || [])
        .map((p) => p.text || "")
        .join("")
        .trim();

      if (!reply) {
        throw new CirrusProviderError(
          "malformed_provider_response",
          `Gemini returned no usable text${
            candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : ""
          }`,
          { status: 502 },
        );
      }

      return { reply, model, finishReason: candidate?.finishReason };
    },
  };
}

function resolveProvider(): CirrusProvider {
  const name = (Deno.env.get("CIRRUS_PROVIDER") ?? DEFAULT_PROVIDER).toLowerCase();
  if (name !== "gemini") {
    throw new CirrusProviderError(
      "server_misconfigured",
      `Unknown CIRRUS_PROVIDER "${name}"`,
      { status: 500 },
    );
  }
  return createGeminiProvider(
    Deno.env.get("GEMINI_API_KEY") ?? "",
    Deno.env.get("CIRRUS_MODEL") ?? DEFAULT_GEMINI_MODEL,
  );
}

/* ---------- CORS ---------- */
function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/* ---------- throttling ----------
   Per-instance sliding window. Edge Functions scale horizontally, so
   this is a best-effort brake against runaway loops, not a hard global
   quota. */
const hits = new Map<string, number[]>();

function rateLimited(userId: string, perMinute: number): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= perMinute) {
    hits.set(userId, recent);
    return true;
  }
  recent.push(now);
  hits.set(userId, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return false;
}

/* ---------- responses + logging ---------- */
function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function errorResponse(
  code: CirrusErrorCode,
  message: string,
  status: number,
  origin: string | null,
) {
  return jsonResponse({ error: { code, message } }, status, origin);
}

/**
 * Deliberately excludes the API key, the caller's access token, message
 * content, system prompt content, and structured context — only shapes,
 * outcomes and provider status metadata.
 */
function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

const userTag = (id: string) => id.slice(0, 8);



/* ============================================================
   DURABLE RATE LIMITING

   Every Gemini request passes through this, and nothing reaches Gemini
   without it — so a rejected request costs nothing at the provider.

   State lives in Postgres rather than in this process. Edge Functions
   scale horizontally and are recycled freely, so a per-instance counter
   means the real ceiling is the limit multiplied by however many
   instances exist, and it resets on every cold start. Postgres gives
   one shared counter, and row locking makes check-and-increment atomic,
   so two requests arriving together cannot both pass a check only one
   of them should.

   The user id comes from a validated Supabase session, never from the
   request body: the caller cannot nominate whose quota to spend.

   Defence in depth. Google's own quotas and the account spend cap are
   the real backstop; this exists so ordinary faults — a retry storm, a
   loop in the client — cannot quietly run up a bill against them.
   ============================================================ */
type LimitDecision = {
  allowed: boolean;
  reason?: "minute" | "daily" | "concurrent" | "unavailable";
  retryAfter?: number;
  minuteCount?: number;
  dayCount?: number;
  degraded?: boolean;
};

function serviceClient() {
  const url = envStr("SUPABASE_URL");
  const key = envStr("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* Per-instance fallback, used only when the database cannot be reached.
   Weaker than the shared counter — it is per instance — but far better
   than no limit at all, and the degradation is logged so it is visible
   rather than silent. */
const localHits = new Map<string, number[]>();
function localLimited(userId: string, perMinute: number): boolean {
  const now = Date.now();
  const recent = (localHits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= perMinute) {
    localHits.set(userId, recent);
    return true;
  }
  recent.push(now);
  localHits.set(userId, recent);
  if (localHits.size > 500) {
    for (const [k, v] of localHits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) localHits.delete(k);
    }
  }
  return false;
}

/** Takes a slot, or explains why not. Also takes the concurrency lease. */
async function acquireSlot(
  db: ReturnType<typeof createClient> | null,
  userId: string,
  perMinute: number,
  perDay: number,
): Promise<LimitDecision> {
  if (db) {
    const { data, error } = await db.rpc("cirrus_rate_acquire", {
      p_user: userId,
      p_rpm: perMinute,
      p_rpd: perDay,
      p_lease_seconds: CONCURRENCY_LEASE_SECONDS,
    });
    if (!error && data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      return {
        allowed: Boolean(d.allowed),
        reason: d.reason as LimitDecision["reason"],
        retryAfter: typeof d.retry_after === "number" ? d.retry_after : undefined,
        minuteCount: typeof d.minute_count === "number" ? d.minute_count : undefined,
        dayCount: typeof d.day_count === "number" ? d.day_count : undefined,
      };
    }
    // The migration has not been applied, or the database is unreachable.
    log("limiter_degraded", { reason: error?.code || "no_data", detail: error?.message?.slice(0, 120) });
  }
  return localLimited(userId, perMinute)
    ? { allowed: false, reason: "minute", retryAfter: 30, degraded: true }
    : { allowed: true, degraded: true };
}

/** Charges a retry. A retry is a Gemini request and is billed as one. */
async function chargeRetry(
  db: ReturnType<typeof createClient> | null,
  userId: string,
  perMinute: number,
  perDay: number,
): Promise<boolean> {
  if (!db) return !localLimited(userId, perMinute);
  const { data, error } = await db.rpc("cirrus_rate_charge", {
    p_user: userId, p_rpm: perMinute, p_rpd: perDay,
  });
  if (error || !data || typeof data !== "object") return !localLimited(userId, perMinute);
  return Boolean((data as Record<string, unknown>).allowed);
}

/** Releases the concurrency lease. Never throws: a failure here must
    not turn a served request into an error. */
async function releaseSlot(db: ReturnType<typeof createClient> | null, userId: string) {
  if (!db) return;
  try {
    await db.rpc("cirrus_rate_release", { p_user: userId });
  } catch {
    // The lease expires on its own; nothing is wedged.
  }
}

const LIMIT_MESSAGES: Record<string, string> = {
  minute: "Cirrus is taking a breather — you've reached the per-minute limit. Try again in a moment.",
  daily: "Cirrus has reached today's request limit. It resets at midnight UTC.",
  concurrent: "Cirrus is still working on your last message. Give it a second.",
  unavailable: "Cirrus can't check its usage limits right now. Try again shortly.",
};

/* ============================================================
   ACTION EXTRACTION

   Cirrus may end a reply with one fenced \u0060cirrus-action\u0060 block. This
   pulls it out, strips it from the text the user sees, and returns it
   separately.

   Nothing here decides anything. It does not know what actions exist,
   what they cost, or whether one needs approval — that is the browser's
   action registry, which validates the name, the parameters and the
   permission before anything runs. This function's only job is to stop
   raw JSON being shown to the user, and to refuse obvious junk early.
   ============================================================ */
const ACTION_FENCE = /```cirrus-action\s*([\s\S]*?)```/i;
const MAX_ACTION_CHARS = 4000;

function extractAction(reply: string): { text: string; action: unknown | null } {
  const match = reply.match(ACTION_FENCE);
  if (!match) return { text: reply, action: null };

  // Remove the block whether or not the JSON inside turns out to parse:
  // a malformed block is still not something to show the user.
  const text = reply.replace(ACTION_FENCE, "").trim();
  const raw = (match[1] || "").trim();
  if (!raw || raw.length > MAX_ACTION_CHARS) return { text, action: null };

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("action_unparsable", { chars: raw.length });
    return { text, action: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text, action: null };
  if (typeof parsed.action !== "string" || !parsed.action) return { text, action: null };
  if (parsed.parameters !== undefined && (typeof parsed.parameters !== "object" || parsed.parameters === null || Array.isArray(parsed.parameters))) {
    return { text, action: null };
  }
  return { text, action: { action: parsed.action.slice(0, 64), parameters: parsed.parameters ?? {} } };
}

/* ---------- main handler ---------- */
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const started = Date.now();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return errorResponse("bad_request", "Use POST", 405, origin);
  }

  /* --- authenticate --- */
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    log("auth_missing", { ms: Date.now() - started });
    return errorResponse("unauthenticated", "Sign in to use Cirrus", 401, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    log("misconfigured", { reason: "missing_supabase_env" });
    return errorResponse("server_misconfigured", "Cirrus is not configured", 500, origin);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) {
    // The anon key alone is a syntactically valid JWT and passes the
    // gateway, so this check is what actually gates access.
    log("auth_rejected", { ms: Date.now() - started });
    return errorResponse("unauthenticated", "Sign in to use Cirrus", 401, origin);
  }

  const allowlist = (Deno.env.get("CIRRUS_ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length && !allowlist.includes((user.email ?? "").toLowerCase())) {
    log("forbidden", { user: userTag(user.id) });
    return errorResponse("forbidden", "This account cannot use Cirrus", 403, origin);
  }

  /* --- throttle ---
     Before parsing, before building a prompt, and well before any
     provider call: a rejected request must cost nothing at Gemini.
     `user.id` comes from the validated session above, so the caller
     cannot spend someone else's quota by naming them. */
  const perMinute = envInt("CIRRUS_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_PER_MINUTE);
  const perDay = envInt("CIRRUS_RATE_LIMIT_PER_DAY", DEFAULT_RATE_LIMIT_PER_DAY);
  const db = serviceClient();

  const slot = await acquireSlot(db, user.id, perMinute, perDay);
  if (!slot.allowed) {
    const reason = slot.reason || "minute";
    log("rate_limited", {
      user: userTag(user.id),
      reason,
      perMinute,
      perDay,
      minuteCount: slot.minuteCount,
      dayCount: slot.dayCount,
      degraded: Boolean(slot.degraded),
    });
    const code: CirrusErrorCode =
      reason === "daily" ? "daily_limit" : reason === "concurrent" ? "busy" : "rate_limited";
    const res = errorResponse(code, LIMIT_MESSAGES[reason] || LIMIT_MESSAGES.minute, 429, origin);
    if (slot.retryAfter) res.headers.set("Retry-After", String(slot.retryAfter));
    return res;
  }

  /* From here every exit must release the concurrency lease, or the
     next request is refused until the lease expires. */
  const finish = async <T>(r: T): Promise<T> => {
    await releaseSlot(db, user.id);
    return r;
  };

  /* --- parse and validate --- */
  let parsed: ChatRequest;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return await finish(errorResponse("bad_request", "Request body too large", 413, origin));
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw bad("Body must be valid JSON");
    }
    parsed = validate(json);
  } catch (err) {
    const e = err as CirrusProviderError;
    const code = e?.code ?? "bad_request";
    log("bad_request", { user: userTag(user.id), code });
    return await finish(errorResponse(code, e?.message ?? "Malformed request", e?.status ?? 400, origin));
  }

  /* --- call the provider --- */
  const maxOutputTokens = envInt("CIRRUS_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutMs = envInt("CIRRUS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  let provider: CirrusProvider;
  try {
    provider = resolveProvider();
  } catch (err) {
    const e = err as CirrusProviderError;
    log("misconfigured", { reason: e?.code ?? "provider_unavailable", detail: e?.message });
    // Never surface the underlying message — it can name env vars.
    return await finish(errorResponse("server_misconfigured", "Cirrus is not configured", 500, origin));
  }

  let lastError: CirrusProviderError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await provider.generate({
        systemPrompt: parsed.systemPrompt,
        history: parsed.history,
        message: parsed.message,
        maxOutputTokens,
        timeoutMs,
      });

      const extracted = extractAction(result.reply);
      const reply = extracted.text.slice(0, MAX_REPLY_CHARS);
      log("ok", {
        actionProposed: extracted.action ? (extracted.action as any).action : null,
        user: userTag(user.id),
        provider: provider.name,
        model: result.model,
        attempt,
        historyCount: parsed.history.length,
        replyChars: reply.length,
        truncated: result.reply.length > MAX_REPLY_CHARS,
        finishReason: result.finishReason,
        ms: Date.now() - started,
      });

      return await finish(jsonResponse(
        {
          reply,
          /* Declares that this deployment understands the action
             protocol. A client that does not see this marker knows the
             function predates it and that no action can possibly have
             run — which is the difference between "nothing happened"
             and "something happened and I wasn't told". */
          contract: "cirrus-action-v1",
          // Present only when Cirrus proposed something. It is an
          // unvalidated suggestion at this point: the browser's action
          // registry decides whether it exists, whether its parameters
          // are acceptable, and whether it needs approval.
          ...(extracted.action ? { action: extracted.action } : {}),
          model: result.model,
          provider: provider.name,
          truncated: extracted.text.length > MAX_REPLY_CHARS,
        },
        200,
        origin,
      ));
    } catch (err) {
      lastError = err instanceof CirrusProviderError
        ? err
        : new CirrusProviderError("unknown", "Unexpected failure", { status: 502 });

      const willRetry = lastError.retryable && attempt < MAX_ATTEMPTS;
      log("provider_failure", {
        user: userTag(user.id),
        provider: provider.name,
        model: provider.model,
        code: lastError.code,
        // Provider's own status and machine-readable reason, e.g. 400 /
        // API_KEY_INVALID. Structural metadata only — no credentials, no
        // prompt or message content.
        providerStatus: lastError.providerStatus,
        providerReason: lastError.providerReason,
        detail: lastError.message,
        attempt,
        willRetry,
        ms: Date.now() - started,
      });

      if (!willRetry) break;

      /* A retry costs quota. Without this the limiter would cap
         "messages" rather than "Gemini requests", and a retry would be
         free — which is the exact hole worth closing. Running out here
         stops the retry rather than queueing behind the limiter. */
      const mayRetry = await chargeRetry(db, user.id, perMinute, perDay);
      if (!mayRetry) {
        log("retry_denied", { user: userTag(user.id), attempt, reason: "quota" });
        break;
      }
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    }
  }

  const e = lastError ?? new CirrusProviderError("unknown", "Unexpected failure");
  const clientMessage = e.code === "server_misconfigured" ? "Cirrus is not configured" : e.message;
  return await finish(errorResponse(e.code, clientMessage, e.status, origin));
});
