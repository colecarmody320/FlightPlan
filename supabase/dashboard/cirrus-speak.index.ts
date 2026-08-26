import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

/* ============================================================
   CIRRUS — SPEECH (ElevenLabs text-to-speech)

   Function name: cirrus-speak
   JWT verification: LEAVE ENABLED (this function requires a signed-in
   user; unlike the OAuth callback there is no browser redirect here).

   Secrets used — all of which already exist:
     ELEVENLABS_API_KEY    the ElevenLabs key
     ELEVENLABS_VOICE_ID   the already-selected Cirrus voice

   Optional overrides (only set these if you need them):
     ELEVENLABS_MODEL_ID          default "eleven_turbo_v2_5"
     ELEVENLABS_OUTPUT_FORMAT     default "mp3_44100_128"
     CIRRUS_SPEAK_RATE_LIMIT_PER_MINUTE  default 20
     CIRRUS_ALLOWED_EMAILS        shared with cirrus-chat

   The key and the voice id never leave this function. The browser
   sends text and receives audio bytes; it cannot name a voice, choose
   a model, or reach ElevenLabs directly.

   Nothing is stored. Audio is streamed straight back to the caller —
   this function writes to no table, no bucket, and no disk.
   ============================================================ */

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 1200;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const RATE_WINDOW_MS = 60_000;

const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

const ALLOWED_ORIGINS = [
  "https://colecarmody320.github.io",
  "http://localhost:5173",
  "http://localhost:5183",
];

type SpeakErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "rate_limited"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_error"
  | "server_misconfigured"
  | "network_error"
  | "unknown";

const envInt = (name: string, fallback: number) => {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/* Every secret is trimmed. A trailing newline pasted into the dashboard
   is invisible and, percent-encoded into a URL or a header, produced a
   long and thoroughly unhelpful provider error last time. */
const envStr = (name: string) => (Deno.env.get(name) ?? "").trim();

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

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

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function errorResponse(
  code: SpeakErrorCode,
  message: string,
  status: number,
  origin: string | null,
) {
  return jsonResponse({ error: { code, message } }, status, origin);
}

/**
 * Deliberately excludes the ElevenLabs key, the voice id, the caller's
 * access token, and the text being spoken. Only shapes, outcomes and
 * timings — never audio, never content.
 */
function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

const userTag = (id: string) => id.slice(0, 8);

/** ElevenLabs reports failures as JSON even on the audio route. Pull out
    the human-readable part so a misconfigured voice or a retired model
    is diagnosable from the client without guesswork. */
async function providerDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      const d = body?.detail;
      const msg =
        (typeof d === "string" && d) ||
        d?.message ||
        (Array.isArray(d) ? d[0]?.msg : null) ||
        body?.message;
      const status = d?.status ? ` (${d.status})` : "";
      return msg ? `${msg}${status}` : `HTTP ${res.status}`;
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

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

  const supabaseUrl = envStr("SUPABASE_URL");
  const anonKey = envStr("SUPABASE_ANON_KEY");
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
    log("auth_rejected", { ms: Date.now() - started });
    return errorResponse("unauthenticated", "Sign in to use Cirrus", 401, origin);
  }

  const allowlist = envStr("CIRRUS_ALLOWED_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length && !allowlist.includes((user.email ?? "").toLowerCase())) {
    log("forbidden", { user: userTag(user.id) });
    return errorResponse("forbidden", "This account cannot use Cirrus", 403, origin);
  }

  /* --- throttle --- */
  const perMinute = envInt("CIRRUS_SPEAK_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_PER_MINUTE);
  if (rateLimited(user.id, perMinute)) {
    log("rate_limited", { user: userTag(user.id), perMinute });
    return errorResponse("rate_limited", "Too much speech in a short window.", 429, origin);
  }

  /* --- parse --- */
  let text: string;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return errorResponse("bad_request", "Request body too large", 413, origin);
    }
    const parsed = JSON.parse(rawBody || "{}");
    const value = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    if (!value) {
      return errorResponse("bad_request", "`text` is required", 400, origin);
    }
    if (value.length > MAX_TEXT_CHARS) {
      return errorResponse("bad_request", `\`text\` exceeds ${MAX_TEXT_CHARS} characters`, 400, origin);
    }
    text = value;
  } catch {
    return errorResponse("bad_request", "Body must be JSON", 400, origin);
  }

  /* --- provider --- */
  const apiKey = envStr("ELEVENLABS_API_KEY");
  const voiceId = envStr("ELEVENLABS_VOICE_ID");
  if (!apiKey || !voiceId) {
    log("misconfigured", {
      reason: "missing_elevenlabs_env",
      hasKey: Boolean(apiKey),
      hasVoice: Boolean(voiceId),
    });
    return errorResponse("server_misconfigured", "Cirrus's voice is not configured", 500, origin);
  }

  const modelId = envStr("ELEVENLABS_MODEL_ID") || DEFAULT_MODEL_ID;
  const outputFormat = envStr("ELEVENLABS_OUTPUT_FORMAT") || DEFAULT_OUTPUT_FORMAT;
  const url =
    `${ELEVENLABS_ENDPOINT}/${encodeURIComponent(voiceId)}` +
    `?output_format=${encodeURIComponent(outputFormat)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), envInt("CIRRUS_SPEAK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        // Settings that suit Cirrus: steady and articulate rather than
        // performative, with enough variation to avoid sounding flat.
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const aborted = (err as Error)?.name === "AbortError";
    log(aborted ? "provider_timeout" : "network_error", {
      user: userTag(user.id),
      ms: Date.now() - started,
    });
    return aborted
      ? errorResponse("provider_timeout", "Cirrus's voice took too long", 504, origin)
      : errorResponse("network_error", "Couldn't reach Cirrus's voice", 502, origin);
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const detail = await providerDetail(res);
    log("provider_error", {
      user: userTag(user.id),
      status: res.status,
      modelId,
      ms: Date.now() - started,
    });
    if (res.status === 429) {
      return errorResponse("provider_rate_limited", "ElevenLabs is rate limiting.", 429, origin);
    }
    return errorResponse(
      "provider_error",
      `ElevenLabs returned ${res.status}: ${detail}`,
      502,
      origin,
    );
  }

  const audio = await res.arrayBuffer();
  if (!audio.byteLength) {
    log("empty_audio", { user: userTag(user.id), ms: Date.now() - started });
    return errorResponse("provider_error", "ElevenLabs returned no audio", 502, origin);
  }

  log("spoken", {
    user: userTag(user.id),
    chars: text.length,
    bytes: audio.byteLength,
    modelId,
    ms: Date.now() - started,
  });

  // octet-stream is what supabase-js hands back as a Blob; the client
  // re-tags it as audio/mpeg. Explicitly uncached: this audio is
  // ephemeral by design.
  return new Response(audio, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
});
