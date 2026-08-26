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
  /* Distinct because the fixes are completely different: a quota
     problem is solved on a billing page, a rejected key in the
     dashboard, a missing voice in the voice library. Collapsing them
     into one "unavailable" message cost a round trip of guessing. */
  | "provider_quota"
  | "provider_payment_required"
  | "provider_blocked"
  | "provider_auth"
  | "provider_voice_missing"
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

/**
 * Pulls apart an ElevenLabs error body.
 *
 * ElevenLabs answers failures as:
 *   { "detail": { "status": "<machine code>", "message": "<prose>" } }
 * and sometimes as { "detail": "<prose>" } or a validation array.
 *
 * The machine code is the part that matters: an HTTP status alone is
 * ambiguous — 402 covers quota, plan entitlement and abuse blocking
 * alike — while `detail.status` names which one. Returning them
 * separately keeps the provider's own verdict intact instead of
 * flattening it into a guess.
 *
 * Contains no key and no request text, so every field here is safe to
 * log and to show the user.
 */
type ProviderFault = { httpStatus: number; code: string | null; message: string };

async function providerFault(res: Response): Promise<ProviderFault> {
  const fallback: ProviderFault = { httpStatus: res.status, code: null, message: `HTTP ${res.status}` };
  try {
    const text = await res.text();
    if (!text) return fallback;
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return { httpStatus: res.status, code: null, message: text.slice(0, 300) };
    }
    const d = body?.detail;
    if (typeof d === "string" && d) return { httpStatus: res.status, code: null, message: d.slice(0, 300) };
    if (Array.isArray(d)) {
      return { httpStatus: res.status, code: null, message: String(d[0]?.msg || text).slice(0, 300) };
    }
    const code = typeof d?.status === "string" ? d.status : null;
    const message = String(d?.message || body?.message || `HTTP ${res.status}`).slice(0, 300);
    return { httpStatus: res.status, code, message };
  } catch {
    return fallback;
  }
}

/**
 * Chooses how to describe a failure, preferring what ElevenLabs said
 * over what its HTTP status implies.
 *
 * The status is only a fallback. 402 in particular is not evidence of
 * an empty balance: it is also returned for plan entitlement and for
 * abuse blocking, and telling someone with credit remaining to go and
 * buy more is worse than saying nothing.
 */
function classifyFault(fault: ProviderFault): { code: SpeakErrorCode; hint: string } {
  switch (fault.code) {
    case "quota_exceeded":
      return { code: "provider_quota", hint: "The ElevenLabs character allowance for this period is used up." };
    case "detected_unusual_activity":
      return {
        code: "provider_blocked",
        hint: "ElevenLabs has blocked Free-tier API use from this server's network. It is an account/plan restriction, not a credit balance.",
      };
    case "missing_permissions":
    case "invalid_api_key":
      return { code: "provider_auth", hint: "The API key lacks the permission this call needs." };
    case "voice_not_found":
      return { code: "provider_voice_missing", hint: "ELEVENLABS_VOICE_ID was not found in this workspace." };
    case "model_not_found":
    case "invalid_model_id":
      return { code: "provider_error", hint: "ElevenLabs does not recognise this model id." };
    default:
      break;
  }
  // No machine code from the provider: describe the status without
  // inventing a reason for it.
  switch (fault.httpStatus) {
    case 401:
    case 403:
      return { code: "provider_auth", hint: "ElevenLabs rejected the API key." };
    case 402:
      return {
        code: "provider_payment_required",
        hint: "ElevenLabs returned 402. That covers plan entitlement and access restrictions as well as balance, so the message below is the authority.",
      };
    case 404:
      return { code: "provider_voice_missing", hint: "ElevenLabs could not find that voice." };
    default:
      return { code: "provider_error", hint: "" };
  }
}

/* ============================================================
   MODEL RESOLUTION

   Model names are the provider's to change, not ours to memorise. A
   hardcoded default is a guess that goes stale silently, and that has
   already cost this project a debugging session once with Gemini.

   So the function asks the account which models it can actually use,
   and picks one:
     - the configured ELEVENLABS_MODEL_ID, if the account has it
     - otherwise a text-to-speech model the account does have
   The substitution is reported in logs and diagnostics, so a wrong
   ELEVENLABS_MODEL_ID becomes a visible note rather than a failure.

   Cached per instance for ten minutes: this is one extra request on a
   cold start, not one per utterance.
   ============================================================ */
let modelCache: { ids: string[]; at: number } | null = null;
const MODEL_CACHE_MS = 10 * 60_000;

async function accountModels(key: string): Promise<string[] | null> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.ids;
  try {
    const r = await timedFetch("https://api.elevenlabs.io/v1/models", {
      headers: { "xi-api-key": key },
    });
    if (!r.ok) return null;
    const list = await r.json();
    const ids: string[] = (Array.isArray(list) ? list : [])
      .filter((m: any) => m?.can_do_text_to_speech !== false)
      .map((m: any) => m?.model_id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) return null;
    modelCache = { ids, at: Date.now() };
    return ids;
  } catch {
    return null;
  }
}

type ModelChoice = { model: string; verified: boolean; substituted: boolean; configured: string | null };

async function chooseModel(key: string): Promise<ModelChoice> {
  const configured = envStr("ELEVENLABS_MODEL_ID") || null;
  const wanted = configured || DEFAULT_MODEL_ID;
  const ids = await accountModels(key);

  // Could not ask — proceed with what we have rather than refusing to
  // speak. If it is wrong, the provider's own message says so.
  if (!ids) return { model: wanted, verified: false, substituted: false, configured };

  if (ids.includes(wanted)) return { model: wanted, verified: true, substituted: false, configured };

  // Prefer low latency for a conversational assistant, then quality,
  // then simply something that works.
  const pick =
    ids.find((i) => /flash/i.test(i)) ||
    ids.find((i) => /turbo/i.test(i)) ||
    ids.find((i) => /multilingual/i.test(i)) ||
    ids[0];
  return { model: pick, verified: true, substituted: true, configured };
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

  /* --- diagnostics ---
     Answers "why is the voice failing?" without ever returning a
     secret. It reports whether each secret is present, which models
     this ElevenLabs account can actually use, and whether the
     configured model is one of them. The key is never echoed; the
     voice id is reduced to a fingerprint so it can be told apart from
     a different one without being disclosed. */
  if (new URL(req.url).searchParams.get("action") === "diagnose") {
    const key = envStr("ELEVENLABS_API_KEY");
    const voice = envStr("ELEVENLABS_VOICE_ID");
    const configuredModel = envStr("ELEVENLABS_MODEL_ID") || DEFAULT_MODEL_ID;
    const resolved = key ? await chooseModel(key) : null;
    const out: Record<string, unknown> = {
      hasApiKey: Boolean(key),
      hasVoiceId: Boolean(voice),
      voiceIdFingerprint: voice ? `…${voice.slice(-4)} (${voice.length} chars)` : null,
      configuredModel,
      usingDefaultModel: !envStr("ELEVENLABS_MODEL_ID"),
      modelActuallyUsed: resolved?.model ?? null,
      modelWasSubstituted: resolved?.substituted ?? null,
    };
    if (!key) {
      out.problem = "ELEVENLABS_API_KEY is not set on this function.";
      return json(out, 200, origin);
    }

    try {
      const mr = await timedFetch("https://api.elevenlabs.io/v1/models", {
        headers: { "xi-api-key": key },
      });
      out.modelsStatus = mr.status;
      if (mr.ok) {
        const models = await mr.json();
        const usable = (Array.isArray(models) ? models : [])
          .filter((m: any) => m?.can_do_text_to_speech !== false)
          .map((m: any) => m?.model_id)
          .filter(Boolean);
        out.availableTextToSpeechModels = usable;
        out.configuredModelIsAvailable = usable.includes(configuredModel);
        if (!usable.includes(configuredModel)) {
          out.problem = `ELEVENLABS_MODEL_ID "${configuredModel}" is not one this account can use. Set it to one of availableTextToSpeechModels.`;
        }
      } else {
        out.problem = `ElevenLabs rejected the key: ${(await providerFault(mr)).message}`;
      }
    } catch (err) {
      out.problem = `Could not reach ElevenLabs: ${(err as Error)?.message || "network error"}`;
    }

    /* A key can be perfectly valid and still have nothing left to
       spend, which is exactly the case that looked like a
       configuration problem and was not. */
    try {
      const sr = await timedFetch("https://api.elevenlabs.io/v1/user/subscription", {
        headers: { "xi-api-key": key },
      });
      if (sr.ok) {
        const sub = await sr.json();
        const used = Number(sub?.character_count ?? 0);
        const limit = Number(sub?.character_limit ?? 0);
        out.charactersUsed = used;
        out.characterLimit = limit;
        out.charactersRemaining = limit ? Math.max(0, limit - used) : null;
        out.tier = sub?.tier ?? null;
        out.status = sub?.status ?? null;
        /* Compare these numbers with what elevenlabs.io shows. If they
           disagree, the key in Supabase belongs to a different
           workspace than the one being looked at — which no amount of
           reading the code would reveal. */
        out.workspaceCheck =
          limit
            ? `This key reports ${Math.max(0, limit - used)} of ${limit} credits remaining on the "${sub?.tier ?? "unknown"}" tier. If that does not match elevenlabs.io, ELEVENLABS_API_KEY is for a different workspace.`
            : "This key reports no character limit; compare the tier against elevenlabs.io.";
        if (limit && used >= limit) {
          out.problem =
            "The ElevenLabs character allowance for this period is fully used.";
        }
      } else {
        out.subscriptionStatus = sr.status;
      }
    } catch {
      out.subscriptionStatus = null;
    }

    /* A live one-word probe. Nothing else establishes what actually
       happens when Cirrus speaks — the models and subscription
       endpoints can both succeed while synthesis is refused, which is
       exactly the situation that made this look like a configuration
       fault. The provider's own verdict is reported verbatim. */
    if (voice) {
      try {
        const probe = await timedFetch(
          `${ELEVENLABS_ENDPOINT}/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(DEFAULT_OUTPUT_FORMAT)}`,
          {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text: "Hi.", model_id: resolved?.model || configuredModel }),
          },
        );
        out.probeStatus = probe.status;
        out.probeContentType = probe.headers.get("content-type");
        if (probe.ok) {
          const bytes = (await probe.arrayBuffer()).byteLength;
          out.probeBytes = bytes;
          out.probeSucceeded = bytes > 0;
          if (bytes > 0) out.problem = null;
        } else {
          const fault = await providerFault(probe);
          out.probeSucceeded = false;
          out.providerCode = fault.code;
          out.providerMessage = fault.message;
          out.problem = `Speech is refused with HTTP ${fault.httpStatus}${fault.code ? ` (${fault.code})` : ""}: ${fault.message}`;
        }
      } catch (err) {
        out.probeSucceeded = null;
        out.probeError = (err as Error)?.name || "error";
      }

      try {
        const vr = await timedFetch(
          `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voice)}`,
          { headers: { "xi-api-key": key } },
        );
        out.voiceStatus = vr.status;
        out.voiceIdIsValid = vr.ok;
        if (!vr.ok) out.problem = `ELEVENLABS_VOICE_ID is not usable: ${(await providerFault(vr)).message}`;
      } catch {
        out.voiceIdIsValid = null;
      }
    }

    log("diagnose", { user: userTag(user.id), hasKey: Boolean(key), hasVoice: Boolean(voice) });
    return json(out, 200, origin);
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

  const choice = await chooseModel(apiKey);
  const modelId = choice.model;
  const outputFormat = envStr("ELEVENLABS_OUTPUT_FORMAT") || DEFAULT_OUTPUT_FORMAT;
  if (choice.substituted) {
    log("model_substituted", { configured: choice.configured, using: modelId });
  }
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
    const fault = await providerFault(res);
    const { code, hint } = classifyFault(fault);
    log("provider_error", {
      user: userTag(user.id),
      status: fault.httpStatus,
      // The provider's own machine-readable verdict. This is the field
      // that distinguishes a spent balance from a blocked plan, and its
      // absence last time is why the cause had to be guessed at.
      providerCode: fault.code,
      providerMessage: fault.message,
      code,
      modelId,
      ms: Date.now() - started,
    });
    if (res.status === 429) {
      return errorResponse("provider_rate_limited", "ElevenLabs is rate limiting.", 429, origin);
    }
    return errorResponse(
      code,
      `${hint ? `${hint} ` : ""}[${fault.httpStatus}${fault.code ? ` ${fault.code}` : ""}, model ${modelId}] ${fault.message}`,
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
    contentType: res.headers.get("content-type"),
    modelId,
    modelVerified: choice.verified,
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
