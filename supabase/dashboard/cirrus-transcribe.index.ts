import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

/* ============================================================
   CIRRUS — TRANSCRIPTION (ElevenLabs speech-to-text)

   Function name: cirrus-transcribe
   JWT verification: LEAVE ENABLED (a signed-in user, like cirrus-speak).

   WHY THIS EXISTS. Stage 7 and 8 transcribed in the browser with
   webkitSpeechRecognition. On iOS that engine is not dependable across
   a continuous conversation: Safari ends and refuses to restart it once
   another element has taken the audio session, which Cirrus's own
   playback does on every single turn. Stage 9 records the utterance
   instead and transcribes it here, where nothing can take the audio
   session away.

   Secrets used — ALREADY SET, nothing new to add:
     ELEVENLABS_API_KEY    the same key cirrus-speak uses
     CIRRUS_ALLOWED_EMAILS shared with cirrus-chat and cirrus-speak

   Optional overrides (only if you need them):
     ELEVENLABS_STT_MODEL_ID              default "scribe_v1"
     CIRRUS_TRANSCRIBE_RATE_LIMIT_PER_MINUTE  default 30
     CIRRUS_TRANSCRIBE_MAX_BYTES          default 6291456 (6 MB)

   NOTHING IS STORED. The audio arrives, is forwarded to ElevenLabs,
   and is dropped when the request ends. This function writes to no
   table, no bucket and no disk, and the recording never reaches
   flightplan_data. The transcript is returned to the caller and is not
   retained here either.
   ============================================================ */

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;   // ~2 minutes of AAC
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

/** Scribe. Overridable so a newer model can be adopted without a code
    change — the provider's own error is surfaced if it is rejected. */
const DEFAULT_STT_MODEL_ID = "scribe_v1";
const ELEVENLABS_STT_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/** Below this an "utterance" is a door slam, not speech. */
const MIN_AUDIO_BYTES = 1200;

const ALLOWED_ORIGINS = [
  "https://colecarmody320.github.io",
  "http://localhost:5173",
  "http://localhost:5183",
];

type TranscribeErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "too_large"
  | "empty_audio"
  | "rate_limited"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_error"
  | "provider_quota"
  | "provider_payment_required"
  | "provider_blocked"
  | "provider_auth"
  | "provider_model_missing"
  | "server_misconfigured"
  | "network_error"
  | "unknown";

const envInt = (name: string, fallback: number) => {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/* Trimmed for the same reason cirrus-speak trims: a trailing newline
   pasted into the dashboard is invisible and breaks a header. */
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
  code: TranscribeErrorCode,
  message: string,
  status: number,
  origin: string | null,
  detail?: string | null,
) {
  return jsonResponse({ error: { code, message, detail: detail ?? null } }, status, origin);
}

/**
 * Shapes, outcomes and timings only. Never the audio, never the
 * transcript, never the key — a transcript is the user's speech and
 * has no business in a log line.
 */
function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

const userTag = (id: string) => id.slice(0, 8);

/**
 * Reads ElevenLabs' own verdict out of a failure body.
 *
 * Same reasoning as cirrus-speak: a quota problem is fixed on a billing
 * page, a rejected key in the dashboard, a bad model id in an env var.
 * Collapsing them into "unavailable" costs a round trip of guessing,
 * and there is no console to read on an iPad.
 */
async function providerFault(
  res: Response,
): Promise<{ code: TranscribeErrorCode; message: string }> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* body already consumed or absent */
  }

  let status: string | null = null;
  let message: string | null = null;
  try {
    const body = JSON.parse(raw);
    const detail = body?.detail ?? body;
    if (typeof detail === "string") message = detail;
    else {
      status = detail?.status ?? null;
      message = detail?.message ?? null;
    }
  } catch {
    message = raw.slice(0, 300) || null;
  }

  const said = (message ?? "").toLowerCase();
  const tag = (status ?? "").toLowerCase();

  if (res.status === 401 || tag === "invalid_api_key" || said.includes("api key")) {
    return { code: "provider_auth", message: message ?? "ElevenLabs rejected the API key." };
  }
  if (res.status === 429 || tag === "too_many_requests") {
    return { code: "provider_rate_limited", message: message ?? "ElevenLabs is rate limiting." };
  }
  if (tag.includes("quota") || said.includes("quota") || said.includes("credits")) {
    return { code: "provider_quota", message: message ?? "ElevenLabs quota exhausted." };
  }
  if (res.status === 402) {
    return {
      code: "provider_payment_required",
      message: message ?? "ElevenLabs refused this request.",
    };
  }
  if (tag.includes("blocked") || said.includes("blocked")) {
    return { code: "provider_blocked", message: message ?? "ElevenLabs blocked this account." };
  }
  // A wrong model id is the single most likely misconfiguration here,
  // and it is fixed by editing one env var — so it gets its own code.
  if (said.includes("model") && (said.includes("not") || said.includes("invalid"))) {
    return {
      code: "provider_model_missing",
      message: message ?? "The configured speech-to-text model is not available to this account.",
    };
  }
  if (res.status >= 500) {
    return { code: "provider_error", message: message ?? `ElevenLabs returned ${res.status}.` };
  }
  return { code: "provider_error", message: message ?? `ElevenLabs returned ${res.status}.` };
}

/** Picks a filename ElevenLabs will infer the container from. */
function filenameFor(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "speech.m4a";
  if (t.includes("webm")) return "speech.webm";
  if (t.includes("ogg")) return "speech.ogg";
  if (t.includes("wav")) return "speech.wav";
  if (t.includes("mpeg") || t.includes("mp3")) return "speech.mp3";
  // Safari records MP4/AAC; everything else in practice records WebM.
  return "speech.m4a";
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const origin = req.headers.get("Origin");

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

  /* --- throttle ---
     A continuous conversation makes one call per utterance, so this
     ceiling is higher than cirrus-speak's. It still bounds a runaway
     client: a loop that recorded silence forever would stop here. */
  const perMinute = envInt("CIRRUS_TRANSCRIBE_RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_PER_MINUTE);
  if (rateLimited(user.id, perMinute)) {
    log("rate_limited", { user: userTag(user.id), perMinute });
    return errorResponse("rate_limited", "Too much speech in a short window.", 429, origin);
  }

  /* --- diagnostics ---
     Same purpose as cirrus-speak's: answer "why is transcription
     failing?" from an iPad, without returning a secret. */
  if (new URL(req.url).searchParams.get("action") === "diagnose") {
    const key = envStr("ELEVENLABS_API_KEY");
    const model = envStr("ELEVENLABS_STT_MODEL_ID") || DEFAULT_STT_MODEL_ID;
    const out: Record<string, unknown> = {
      hasElevenLabsKey: Boolean(key),
      sttModel: model,
      usingDefaultModel: !envStr("ELEVENLABS_STT_MODEL_ID"),
      maxBytes: envInt("CIRRUS_TRANSCRIBE_MAX_BYTES", DEFAULT_MAX_BYTES),
      problem: null as string | null,
    };
    if (!key) out.problem = "ELEVENLABS_API_KEY is not set on this function.";
    return jsonResponse(out, 200, origin);
  }

  const key = envStr("ELEVENLABS_API_KEY");
  if (!key) {
    log("misconfigured", { reason: "missing_elevenlabs_key" });
    return errorResponse(
      "server_misconfigured",
      "Cirrus's transcription isn't configured on the server.",
      500,
      origin,
    );
  }

  /* --- read the audio --- */
  const maxBytes = envInt("CIRRUS_TRANSCRIBE_MAX_BYTES", DEFAULT_MAX_BYTES);
  const declared = Number.parseInt(req.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    log("too_large", { user: userTag(user.id), declared });
    return errorResponse("too_large", "That recording is too long.", 413, origin);
  }

  let audio: Blob | null = null;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (file instanceof File || file instanceof Blob) audio = file;
  } catch (err) {
    log("bad_form", { user: userTag(user.id), message: (err as Error)?.message });
    return errorResponse("bad_request", "Send the recording as multipart form data.", 400, origin);
  }

  if (!audio) {
    return errorResponse("bad_request", "No recording was attached.", 400, origin);
  }
  if (audio.size > maxBytes) {
    log("too_large", { user: userTag(user.id), size: audio.size });
    return errorResponse("too_large", "That recording is too long.", 413, origin);
  }
  /* Not an error worth a banner: a continuous loop legitimately
     produces near-empty clips when the room is quiet. The caller
     treats this as "nothing was said" and listens again. */
  if (audio.size < MIN_AUDIO_BYTES) {
    log("empty_audio", { user: userTag(user.id), size: audio.size });
    return errorResponse("empty_audio", "Nothing was recorded.", 422, origin);
  }

  /* --- transcribe --- */
  const model = envStr("ELEVENLABS_STT_MODEL_ID") || DEFAULT_STT_MODEL_ID;
  const outbound = new FormData();
  outbound.append("model_id", model);
  outbound.append("file", audio, filenameFor((audio as File).type || ""));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ELEVENLABS_STT_ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": key },   // FormData sets its own boundary
      body: outbound,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === "AbortError";
    log(aborted ? "provider_timeout" : "network_error", {
      user: userTag(user.id),
      ms: Date.now() - started,
    });
    return aborted
      ? errorResponse("provider_timeout", "Transcription took too long.", 504, origin)
      : errorResponse("network_error", "Couldn't reach transcription.", 502, origin);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const fault = await providerFault(res);
    log("provider_fault", {
      user: userTag(user.id),
      status: res.status,
      code: fault.code,
      ms: Date.now() - started,
    });
    const status = res.status === 429 ? 429 : res.status === 401 ? 502 : 502;
    return errorResponse(fault.code, "Cirrus couldn't transcribe that.", status, origin, fault.message);
  }

  let text = "";
  let language: string | null = null;
  try {
    const body = await res.json();
    text = typeof body?.text === "string" ? body.text.trim() : "";
    language = typeof body?.language_code === "string" ? body.language_code : null;
  } catch (err) {
    log("bad_provider_body", { user: userTag(user.id), message: (err as Error)?.message });
    return errorResponse("provider_error", "Transcription returned something unreadable.", 502, origin);
  }

  /* A confident "" is a real answer — the user said nothing. It is
     reported as success with empty text so the caller listens again
     rather than showing an error for ordinary silence. */
  log("ok", {
    user: userTag(user.id),
    chars: text.length,          // length only, never the words
    bytes: audio.size,
    ms: Date.now() - started,
  });

  return jsonResponse({ text, language }, 200, origin);
});
