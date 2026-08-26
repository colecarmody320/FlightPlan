import { supabase } from "./supabase.js";

/* ============================================================
   CIRRUS — TRANSCRIPTION CLIENT (Stage 9)

   Sends a recorded utterance to our own Edge Function and gets text
   back. The ElevenLabs key never reaches the browser: this module knows
   a function name and nothing else — no provider endpoint, no key, no
   model id.

   NOTHING IS STORED. The Blob is created for one request and dropped
   when it resolves. No cache, no IndexedDB, no upload to storage, and
   nothing in flightplan_data.
   ============================================================ */

const FN = "cirrus-transcribe";

export const TRANSCRIBE_ERRORS = {
  unauthenticated: "Sign in again to use Cirrus's voice.",
  forbidden: "This account can't use Cirrus.",
  server_misconfigured: "Cirrus's transcription isn't configured on the server.",
  rate_limited: "Too much speech in a short window.",
  too_large: "That was too long to transcribe in one go.",
  provider_auth: "ElevenLabs rejected the API key.",
  provider_quota: "Cirrus's voice has used its ElevenLabs allowance for this period.",
  provider_payment_required: "ElevenLabs refused this request.",
  provider_blocked: "ElevenLabs has blocked this account.",
  provider_rate_limited: "ElevenLabs is rate limiting transcription.",
  provider_model_missing: "The configured transcription model isn't available to this account.",
  provider_timeout: "Transcription took too long.",
  provider_error: "Cirrus's transcription is unavailable right now.",
  bad_request: "That recording couldn't be transcribed.",
  network_error: "Couldn't reach Cirrus's transcription.",
  not_deployed: "Cirrus's transcription function isn't deployed yet.",
  unknown: "Cirrus couldn't transcribe that.",
};

/**
 * Transcribes one utterance.
 *
 * Never throws — every failure comes back as a code, so a continuous
 * session can decide whether to listen again rather than crash.
 *
 * `empty_audio` is returned as a *successful* silence rather than an
 * error: a hands-free loop legitimately records near-nothing when the
 * room is quiet, and that must re-arm the microphone, not raise a
 * banner.
 */
export async function transcribeAudio(blob) {
  if (!blob || !blob.size) return { ok: true, text: "", empty: true };

  const { data: session } = await supabase.auth.getSession();
  if (!session?.session) return { ok: false, code: "unauthenticated" };

  const form = new FormData();
  // The filename carries the container; the function maps it to
  // something ElevenLabs can infer a format from.
  form.append("file", blob, "speech");

  let res;
  try {
    res = await supabase.functions.invoke(FN, { body: form });
  } catch (err) {
    return { ok: false, code: "network_error", detail: err?.message };
  }

  if (res.error) {
    const ctx = res.error?.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = await ctx.json();
        const code = body?.error?.code;
        // Silence is not a failure. The loop listens again.
        if (code === "empty_audio") return { ok: true, text: "", empty: true };
        if (code) return { ok: false, code, detail: body?.error?.detail || body?.error?.message };
      } catch {
        /* fall through to status mapping */
      }
      if (ctx.status === 401) return { ok: false, code: "unauthenticated" };
      if (ctx.status === 403) return { ok: false, code: "forbidden" };
      if (ctx.status === 413) return { ok: false, code: "too_large" };
      if (ctx.status === 429) return { ok: false, code: "rate_limited" };
      // A missing function is a deployment problem, not a provider one —
      // saying "transcription is unavailable" would send the search in
      // exactly the wrong direction.
      if (ctx.status === 404) return { ok: false, code: "not_deployed", detail: `HTTP 404 from ${FN}` };
      if (ctx.status >= 500) return { ok: false, code: "provider_error", detail: `HTTP ${ctx.status}` };
      return { ok: false, code: "bad_request", detail: `HTTP ${ctx.status}` };
    }
    return { ok: false, code: "network_error", detail: res.error?.message };
  }

  const text = typeof res.data?.text === "string" ? res.data.text.trim() : "";
  return { ok: true, text, language: res.data?.language ?? null, empty: !text };
}

/** Asks the function to report its own configuration. Findings, never
    secrets — the same idea as the voice diagnostic. */
export async function diagnoseTranscription() {
  const { data: session } = await supabase.auth.getSession();
  if (!session?.session) return { ok: false, code: "unauthenticated" };
  let res;
  try {
    res = await supabase.functions.invoke(`${FN}?action=diagnose`, { body: new FormData() });
  } catch (err) {
    return { ok: false, code: "network_error", detail: err?.message };
  }
  if (res.error) {
    const ctx = res.error?.context;
    if (ctx?.status === 404) {
      return { ok: false, code: "not_deployed", detail: `${FN} is not deployed (HTTP 404).` };
    }
    return { ok: false, code: "unknown", detail: res.error?.message };
  }
  return { ok: true, report: res.data };
}
