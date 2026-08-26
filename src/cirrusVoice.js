import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase.js";

/* ============================================================
   CIRRUS — SPEECH OUTPUT (Stage 7)

   ElevenLabs text-to-speech, reached only through our own
   authenticated Edge Function. The browser never sees ELEVENLABS_API_KEY
   or ELEVENLABS_VOICE_ID: it sends text and receives audio bytes. There
   is no ElevenLabs endpoint, SDK, key, or voice id in this bundle.

   NOTHING IS STORED. Each reply is synthesised on demand, played from
   an object URL, and revoked the moment playback ends or is
   interrupted. No cache, no IndexedDB, no file, no audio in
   flightplan_data.

   FAILURE IS ALWAYS COSMETIC. Speech is a transport layered over a
   reply the user can already read. Every failure path here returns
   quietly and leaves the transcript untouched — the text response is
   never delayed, withheld, or discarded because ElevenLabs is
   unavailable.
   ============================================================ */

const FN = "cirrus-speak";

/** Longest reply we will synthesise. Past this we speak the opening and
    let the user read the rest, rather than paying for a minute of audio
    nobody listens to. */
export const MAX_SPEAK_CHARS = 1200;

export const TTS_ERRORS = {
  unauthenticated: "Sign in again to use Cirrus's voice.",
  server_misconfigured: "Cirrus's voice isn't configured on the server.",
  rate_limited: "Too much speech in a short window.",
  provider_error: "Cirrus's voice is unavailable right now.",
  /* Named separately because each one has a different fix, and the
     user is the only person who can apply any of them. */
  provider_quota: "Cirrus's voice is out of ElevenLabs credit for this billing period.",
  provider_auth: "ElevenLabs rejected the API key.",
  provider_voice_missing: "The configured Cirrus voice no longer exists on ElevenLabs.",
  provider_rate_limited: "ElevenLabs is rate limiting Cirrus's voice.",
  provider_timeout: "Cirrus's voice took too long to respond.",
  bad_request: "That reply couldn't be spoken.",
  network_error: "Couldn't reach Cirrus's voice.",
  not_deployed: "Cirrus's voice function isn't deployed yet.",
  playback_blocked: "Your browser blocked audio playback.",
  empty_audio: "No audio came back.",
  unknown: "Cirrus couldn't speak that.",
};

/* A 0.05s silent WAV. Played inside the tap that starts a voice turn so
   Safari marks the element as user-activated; the real audio arrives
   seconds later on a network continuation, which iOS would otherwise
   refuse to play. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

/** Trim to a sentence boundary rather than mid-word. */
function clip(text) {
  const s = String(text || "").trim();
  if (s.length <= MAX_SPEAK_CHARS) return s;
  const cut = s.slice(0, MAX_SPEAK_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > MAX_SPEAK_CHARS * 0.5 ? cut.slice(0, stop + 1) : cut;
}

/**
 * Asks the Edge Function for audio. Returns a Blob or an error code —
 * never throws, so a caller can always fall through to text-only.
 */
export async function fetchSpeech(text) {
  const body = clip(text);
  if (!body) return { ok: false, code: "bad_request" };

  const { data: session } = await supabase.auth.getSession();
  if (!session?.session) return { ok: false, code: "unauthenticated" };

  let res;
  try {
    res = await supabase.functions.invoke(FN, { body: { text: body } });
  } catch (err) {
    return { ok: false, code: "network_error", detail: err?.message };
  }

  if (res.error) {
    const ctx = res.error?.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const b = await ctx.json();
        const code = b?.error?.code;
        if (code) return { ok: false, code, detail: b?.error?.message };
      } catch {
        /* fall through to status mapping */
      }
      if (ctx.status === 401) return { ok: false, code: "unauthenticated" };
      if (ctx.status === 429) return { ok: false, code: "rate_limited" };
      // A missing function is a deployment problem, not a provider one.
      // Saying "ElevenLabs is unavailable" when cirrus-speak was never
      // deployed sends the search in exactly the wrong direction.
      if (ctx.status === 404) return { ok: false, code: "not_deployed", detail: `HTTP 404 from ${FN}` };
      if (ctx.status >= 500) return { ok: false, code: "provider_error", detail: `HTTP ${ctx.status}` };
      return { ok: false, code: "bad_request", detail: `HTTP ${ctx.status}` };
    }
    return { ok: false, code: "network_error", detail: res.error?.message };
  }

  // The function replies as application/octet-stream, which supabase-js
  // hands back as a Blob. Re-tag it so the audio element knows what it
  // is holding.
  const raw = res.data;
  if (!(raw instanceof Blob) || raw.size === 0) return { ok: false, code: "empty_audio" };
  return { ok: true, blob: new Blob([raw], { type: "audio/mpeg" }) };
}

/**
 * Asks the Edge Function to check its own ElevenLabs configuration.
 *
 * Returns findings, never secrets: which secrets are set, which models
 * the account can actually use, and whether the configured one is among
 * them. Exists because the alternative is guessing at ElevenLabs from
 * the outside, and because there is no console to read on an iPad.
 */
export async function diagnoseVoice() {
  const { data: session } = await supabase.auth.getSession();
  if (!session?.session) return { ok: false, code: "unauthenticated" };
  let res;
  try {
    res = await supabase.functions.invoke(`${FN}?action=diagnose`, { body: {} });
  } catch (err) {
    return { ok: false, code: "network_error", detail: err?.message };
  }
  if (res.error) {
    const ctx = res.error?.context;
    if (ctx?.status === 404) {
      return { ok: false, code: "not_deployed", detail: `${FN} is not deployed (HTTP 404).` };
    }
    if (ctx && typeof ctx.json === "function") {
      try {
        const b = await ctx.json();
        if (b?.error?.code) return { ok: false, code: b.error.code, detail: b.error.message };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, code: "unknown", detail: res.error?.message };
  }
  return { ok: true, report: res.data };
}

/**
 * Owns exactly one <audio> element for the session.
 *
 * One element, reused, is what makes iOS playback work: it is unlocked
 * once inside a real tap and stays unlocked. It also means a new voice
 * turn inherently interrupts the previous one — there is no second
 * element that could keep talking over it.
 */
export function useCirrusVoice({ enabled = true } = {}) {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(null);

  const audioRef = useRef(null);
  const urlRef = useRef(null);
  const unlockedRef = useRef(false);
  // Increments on every stop/new request; a synthesis that resolves
  // after its turn was abandoned checks this and drops its audio.
  const turnRef = useRef(0);

  const getAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    if (typeof Audio === "undefined") return null;
    const a = new Audio();
    a.preload = "auto";
    a.autoplay = false;
    audioRef.current = a;
    return a;
  }, []);

  const releaseUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  /** Stops playback and frees the audio immediately. */
  const stop = useCallback(() => {
    turnRef.current += 1;
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
        a.removeAttribute("src");
        a.load();
      } catch {
        /* nothing playing */
      }
    }
    releaseUrl();
    setSpeaking(false);
  }, [releaseUrl]);

  /**
   * Call synchronously inside a user gesture (the mic tap). Playing a
   * moment of silence there is what buys us permission to play real
   * audio later in the same session.
   */
  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    const a = getAudio();
    if (!a) return;
    try {
      a.src = SILENT_WAV;
      const p = a.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
      unlockedRef.current = true;
    } catch {
      /* Some engines refuse even this; speak() reports the block. */
    }
  }, [getAudio]);

  /**
   * Speaks `text`. Resolves to {ok:true} or {ok:false, code} — the
   * caller ignores the result unless it wants to show why voice is
   * quiet. The reply is already on screen either way.
   */
  const speak = useCallback(
    async (text) => {
      if (!enabled) return { ok: false, code: "disabled" };
      const a = getAudio();
      if (!a) return { ok: false, code: "unknown" };

      // A new utterance always supersedes the old one.
      stop();
      const turn = turnRef.current;

      const result = await fetchSpeech(text);
      if (!result.ok) {
        if (turn === turnRef.current) {
          setError({
            code: result.code,
            message: TTS_ERRORS[result.code] || TTS_ERRORS.unknown,
            // The provider's own words. Dropping these is what turns a
            // five-minute fix into a debugging session — there is no
            // console to check on an iPad.
            detail: result.detail || null,
          });
        }
        return result;
      }
      // The turn was cancelled while we were synthesising.
      if (turn !== turnRef.current) return { ok: false, code: "superseded" };

      const url = URL.createObjectURL(result.blob);
      urlRef.current = url;
      a.src = url;

      const done = () => {
        if (turn !== turnRef.current) return;
        setSpeaking(false);
        releaseUrl();
      };
      a.onended = done;
      a.onerror = done;

      try {
        setSpeaking(true);
        setError(null);
        await a.play();
        return { ok: true };
      } catch {
        // Autoplay refused — usually because the turn didn't start from
        // a tap. Text is already visible, so this is a quiet failure.
        setSpeaking(false);
        releaseUrl();
        setError({ code: "playback_blocked", message: TTS_ERRORS.playback_blocked });
        return { ok: false, code: "playback_blocked" };
      }
    },
    [enabled, getAudio, stop, releaseUrl]
  );

  // Never leave audio playing or an object URL alive behind us.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        try {
          a.pause();
          a.removeAttribute("src");
        } catch {
          /* already gone */
        }
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);

  const clearError = useCallback(() => setError(null), []);

  return { speaking, speak, stop, unlock, error, clearError };
}
