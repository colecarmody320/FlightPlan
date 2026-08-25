import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.4";
import { resolveProvider } from "./providers/index.ts";
import { CirrusErrorCode, CirrusProviderError } from "./providers/types.ts";
import {
  ChatRequest,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_BODY_BYTES,
  MAX_REPLY_CHARS,
  RATE_WINDOW_MS,
  validate,
} from "./validation.ts";

/* ============================================================
   CIRRUS CHAT — authenticated Gemini relay
   The browser never talks to Gemini. It calls this function with a
   Supabase session; this function verifies the user, enforces its own
   limits, and holds GEMINI_API_KEY server-side.

   READ/CONVERSATION ONLY. This function has no write path into
   flightplan_data or any other table, and returns text — never an
   instruction the client acts on. A failure here returns an error
   code and nothing else: there is no fallback content, no seed, no
   default state, and nothing the client could mistake for data.
   ============================================================ */

/* Limits and request validation live in ./validation.ts so they can be
   unit-tested away from the edge runtime. */

const ALLOWED_ORIGINS = [
  "https://colecarmody320.github.io",
  "http://localhost:5173",
  "http://localhost:5183",
];

const envInt = (name: string, fallback: number) => {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

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
   this is a best-effort brake against runaway loops and accidental
   spam, not a hard global quota. Gemini's own quota is the real
   ceiling; this keeps us from sprinting into it. */
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

  // Opportunistic cleanup so the map can't grow without bound.
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return false;
}

/* ---------- responses ---------- */
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
 * Structured logging. Deliberately excludes the API key, the caller's
 * access token, message content, and structured context — only shapes
 * and outcomes, plus a short non-reversible user tag for correlating
 * one session's requests.
 */
function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

const userTag = (id: string) => id.slice(0, 8);

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

  // Optional second gate: FlightPlan is single-user, so an allowlist
  // keeps a stray authenticated account from spending the quota.
  const allowlist = (Deno.env.get("CIRRUS_ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length && !allowlist.includes((user.email ?? "").toLowerCase())) {
    log("forbidden", { user: userTag(user.id) });
    return errorResponse("forbidden", "This account cannot use Cirrus", 403, origin);
  }

  /* --- throttle --- */
  const perMinute = envInt("CIRRUS_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_PER_MINUTE);
  if (rateLimited(user.id, perMinute)) {
    log("rate_limited", { user: userTag(user.id), perMinute });
    return errorResponse(
      "rate_limited",
      "Too many requests in a short window. Give it a moment.",
      429,
      origin,
    );
  }

  /* --- parse and validate --- */
  let parsed: ChatRequest;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return errorResponse("bad_request", "Request body too large", 413, origin);
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new CirrusProviderError("bad_request", "Body must be valid JSON", { status: 400 });
    }
    parsed = validate(json);
  } catch (err) {
    const e = err as CirrusProviderError;
    const code = e?.code ?? "bad_request";
    log("bad_request", { user: userTag(user.id), code });
    return errorResponse(code, e?.message ?? "Malformed request", e?.status ?? 400, origin);
  }

  /* --- call the provider --- */
  const maxOutputTokens = envInt("CIRRUS_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutMs = envInt("CIRRUS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  let provider;
  try {
    provider = resolveProvider();
  } catch (err) {
    const e = err as CirrusProviderError;
    log("misconfigured", { reason: e?.code ?? "provider_unavailable" });
    // Never surface the underlying message — it can name env vars.
    return errorResponse("server_misconfigured", "Cirrus is not configured", 500, origin);
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

      const reply = result.reply.slice(0, MAX_REPLY_CHARS);
      log("ok", {
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

      return jsonResponse(
        {
          reply,
          model: result.model,
          provider: provider.name,
          truncated: result.reply.length > MAX_REPLY_CHARS,
        },
        200,
        origin,
      );
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
      // Short backoff with jitter — one retry only, so this stays snappy.
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    }
  }

  const e = lastError ?? new CirrusProviderError("unknown", "Unexpected failure");
  // server_misconfigured messages can name env vars; keep them internal.
  const clientMessage = e.code === "server_misconfigured" ? "Cirrus is not configured" : e.message;
  return errorResponse(e.code, clientMessage, e.status, origin);
});
