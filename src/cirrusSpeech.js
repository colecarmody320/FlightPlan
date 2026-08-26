import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ============================================================
   CIRRUS — SPEECH INPUT (Stage 7)

   Microphone capture and transcription, using the browser's own
   SpeechRecognition API.

   WHY THIS AND NOT AN UPLOAD PIPELINE. FlightPlan is used mostly on
   iPad/Safari, and webkitSpeechRecognition has shipped there since iOS
   14.5 (desktop Safari 14.1, Chrome 33). Using it means FlightPlan
   never creates a MediaStream, never opens a MediaRecorder, and never
   holds an audio buffer — so "raw audio is not stored" is a structural
   property of this module, not a promise we have to keep. It also adds
   no new external service, no new secret, and no per-minute cost.

   The honest caveat: the platform's recognizer may send audio to Apple
   or Google to transcribe, exactly as the keyboard's dictation key
   does. That audio never reaches FlightPlan's servers, Supabase, or
   any provider we chose. The UI says so before the first use.

   WHAT THIS MODULE IS NOT. It is not a second Cirrus. It produces a
   string and hands it to the same submit path typed text uses. There
   is no voice-specific conversation, prompt, or action route.
   ============================================================ */

export const SPEECH_STATES = {
  IDLE: "idle",
  LISTENING: "listening",
  DENIED: "denied",
  UNAVAILABLE: "unavailable",
  ERROR: "error",
};

/** Hard ceiling on a single utterance. The recognizer usually ends
    itself on a natural pause; this is the backstop for the case where
    it does not (a noisy room holds the endpointer open). */
export const MAX_LISTEN_MS = 15000;

/** Below this, a transcript is offered for confirmation rather than
    sent. Safari frequently reports 0 or omits confidence entirely, so
    an unreported score is treated as unknown, never as low — otherwise
    voice would be unusable on the very browser this targets. */
export const MIN_CONFIDENCE = 0.5;

export const SPEECH_ERRORS = {
  denied: "Microphone access is off. Turn it on in your browser settings to use voice.",
  unavailable: "This browser can't transcribe speech. Typing still works.",
  no_speech: "I didn't catch anything.",
  audio_capture: "No microphone is available.",
  network: "Speech recognition couldn't reach the network.",
  aborted: "Stopped.",
  unknown: "Voice input stopped unexpectedly.",
};

/** Feature detection only — this touches no device and prompts nothing. */
export function speechSupport() {
  if (typeof window === "undefined") return { available: false, reason: "unavailable", Impl: null };
  const Impl = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if (!Impl) return { available: false, reason: "unavailable", Impl: null };
  // Recognition requires a secure context in every engine that ships it.
  if (!window.isSecureContext && window.location?.hostname !== "localhost") {
    return { available: false, reason: "unavailable", Impl: null };
  }
  return { available: true, reason: null, Impl };
}

/** Maps the spec's error strings onto our own vocabulary. */
function mapError(err) {
  switch (err) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "no-speech":
      return "no_speech";
    case "audio-capture":
      return "audio_capture";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "unknown";
  }
}

/**
 * One microphone session at a time.
 *
 * `onTranscript(text, meta)` fires once per completed utterance, with
 * `meta.confidence` (a number, or null when the platform didn't say)
 * and `meta.low` set when a reported score fell below the threshold.
 * The caller decides what to do with a low-confidence transcript; this
 * module never sends anything anywhere itself.
 */
export function useVoiceInput({ enabled = false, onTranscript } = {}) {
  const support = useMemo(speechSupport, []);
  const [state, setState] = useState(support.available ? SPEECH_STATES.IDLE : SPEECH_STATES.UNAVAILABLE);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState(null);

  const recognitionRef = useRef(null);
  const startingRef = useRef(false);   // covers the async gap before onstart
  const finalRef = useRef("");
  const confidenceRef = useRef(null);
  const timerRef = useRef(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Once the user has said no, we explain instead of prompting again.
  // Browsers remember the decision anyway; re-calling start() would
  // just produce a silent failure or a nagging second prompt.
  const deniedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const teardown = useCallback(() => {
    clearTimer();
    const r = recognitionRef.current;
    recognitionRef.current = null;
    startingRef.current = false;
    if (!r) return;
    // Drop handlers first so a late event from a session we've
    // abandoned can't deliver a transcript or flip state.
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    r.onstart = null;
    try {
      r.abort();
    } catch {
      /* already finished */
    }
  }, []);

  /** Hard cancel: no transcript is delivered. */
  const cancel = useCallback(() => {
    finalRef.current = "";
    confidenceRef.current = null;
    teardown();
    setInterim("");
    setState((s) => (s === SPEECH_STATES.LISTENING ? SPEECH_STATES.IDLE : s));
  }, [teardown]);

  /** Graceful stop: whatever was heard so far is delivered by onend. */
  const stop = useCallback(() => {
    clearTimer();
    const r = recognitionRef.current;
    if (!r) return;
    try {
      r.stop();
    } catch {
      teardown();
      setState(SPEECH_STATES.IDLE);
    }
  }, [teardown]);

  const start = useCallback(() => {
    if (!enabled) return { ok: false, code: "disabled" };
    if (!support.available) {
      setState(SPEECH_STATES.UNAVAILABLE);
      setError({ code: "unavailable", message: SPEECH_ERRORS.unavailable });
      return { ok: false, code: "unavailable" };
    }
    if (deniedRef.current) {
      setState(SPEECH_STATES.DENIED);
      setError({ code: "denied", message: SPEECH_ERRORS.denied });
      return { ok: false, code: "denied" };
    }
    // A second tap while a session is live must not open a second one.
    if (recognitionRef.current || startingRef.current) return { ok: false, code: "already_listening" };

    let r;
    try {
      r = new support.Impl();
    } catch {
      setState(SPEECH_STATES.UNAVAILABLE);
      setError({ code: "unavailable", message: SPEECH_ERRORS.unavailable });
      return { ok: false, code: "unavailable" };
    }

    // Stage 7 is one utterance per deliberate tap. Continuous listening
    // is Stage 8's problem, and there is no wake word here at all.
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    try {
      r.lang = navigator.language || "en-US";
    } catch {
      /* engine may reject an odd tag; its default is fine */
    }

    finalRef.current = "";
    confidenceRef.current = null;
    setInterim("");
    setError(null);
    startingRef.current = true;

    r.onstart = () => {
      startingRef.current = false;
      setState(SPEECH_STATES.LISTENING);
    };

    r.onresult = (event) => {
      let live = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          finalRef.current = `${finalRef.current} ${alt.transcript || ""}`.trim();
          // Safari often reports 0; treat that as "not reported".
          if (typeof alt.confidence === "number" && alt.confidence > 0) {
            confidenceRef.current =
              confidenceRef.current === null
                ? alt.confidence
                : Math.min(confidenceRef.current, alt.confidence);
          }
        } else {
          live += alt.transcript || "";
        }
      }
      setInterim(live);
    };

    r.onerror = (event) => {
      const code = mapError(event?.error);
      if (code === "denied") deniedRef.current = true;
      clearTimer();
      // "aborted" is our own cancel() and "no-speech" is a normal
      // silent session; neither is worth an error banner.
      if (code === "aborted") return;
      setError({ code, message: SPEECH_ERRORS[code] || SPEECH_ERRORS.unknown });
      setState(
        code === "denied"
          ? SPEECH_STATES.DENIED
          : code === "audio_capture" || code === "unavailable"
          ? SPEECH_STATES.UNAVAILABLE
          : code === "no_speech"
          ? SPEECH_STATES.IDLE
          : SPEECH_STATES.ERROR
      );
    };

    r.onend = () => {
      clearTimer();
      recognitionRef.current = null;
      startingRef.current = false;
      setInterim("");
      setState((s) => (s === SPEECH_STATES.LISTENING ? SPEECH_STATES.IDLE : s));

      const text = finalRef.current.trim();
      finalRef.current = "";
      const confidence = confidenceRef.current;
      confidenceRef.current = null;
      // An empty utterance is not a message. Nothing is sent, nothing
      // is fabricated, and no action can follow from it.
      if (!text) return;
      onTranscriptRef.current?.(text, {
        confidence,
        low: typeof confidence === "number" && confidence < MIN_CONFIDENCE,
      });
    };

    try {
      r.start();
    } catch {
      startingRef.current = false;
      setState(SPEECH_STATES.ERROR);
      setError({ code: "unknown", message: SPEECH_ERRORS.unknown });
      return { ok: false, code: "unknown" };
    }

    recognitionRef.current = r;
    timerRef.current = setTimeout(() => {
      try {
        r.stop();
      } catch {
        /* it ended on its own */
      }
    }, MAX_LISTEN_MS);

    return { ok: true };
  }, [enabled, support]);

  // Leaving the page, closing the panel, or switching Cirrus off must
  // release the microphone immediately.
  useEffect(() => teardown, [teardown]);
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const clearError = useCallback(() => setError(null), []);

  return {
    supported: support.available,
    state,
    listening: state === SPEECH_STATES.LISTENING,
    interim,
    error,
    start,
    stop,
    cancel,
    clearError,
  };
}
