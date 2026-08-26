import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerStream, releaseMicrophone } from "./cirrusSpeech.js";
import { transcribeAudio, TRANSCRIBE_ERRORS } from "./cirrusTranscribe.js";

/* ============================================================
   CIRRUS — RECORDED SPEECH INPUT (Stage 9)

   getUserMedia → MediaRecorder → our own Edge Function → text.

   WHY THIS REPLACES webkitSpeechRecognition ON iOS. Safari's recognizer
   cannot survive a continuous conversation. It ends when another
   element takes the audio session — which Cirrus's own playback does on
   every single turn — and once ended it will not reliably restart
   without a fresh user gesture. Stage 8 could report that failure
   honestly but could not fix it, because the engine's lifecycle is not
   ours to control. A MediaRecorder is: we decide when it opens, when it
   closes, and what happens to the bytes.

   THE CONTRACT IS IDENTICAL to useVoiceInput's, deliberately. The
   session controller drives either one without knowing which it has —
   same start/stop/cancel/release, same `listening`, same
   onTranscript(text, meta) and onEnd({delivered, reason, fatal}). That
   is what keeps Stage 8's loop, its brakes, and its pause/interrupt
   semantics intact under a completely different capture engine.

   WHAT IT COSTS. Audio now leaves the device to be transcribed, where
   webkitSpeechRecognition kept it on the platform's own service. It
   goes to our Edge Function and then to ElevenLabs, is never written to
   any table, bucket or disk, and is dropped when the request resolves.
   The UI says so before first use.

   END OF SPEECH is measured, not guessed: an AnalyserNode reads the
   live level and the recorder stops after a real pause. Every threshold
   is a named constant below so it can be tuned without reading the
   logic.
   ============================================================ */

export const RECORDER_STATES = {
  IDLE: "idle",
  LISTENING: "listening",
  TRANSCRIBING: "transcribing",
  DENIED: "denied",
  UNAVAILABLE: "unavailable",
  ERROR: "error",
};

/* ---------- tuning ---------- */

/** How often the level is sampled. Fine enough to catch a short pause,
    coarse enough to cost nothing. */
export const VAD_INTERVAL_MS = 50;

/** RMS (0–1) above which a sample counts as speech. Deliberately low:
    echo cancellation and AGC are on, and a quiet talker on an iPad
    sits nearer 0.03 than 0.2. */
export const SPEECH_RMS_THRESHOLD = 0.018;

/** Consecutive loud samples before we believe speech has started. Two
    at 50ms rejects a click or a door without delaying a real word. */
export const SPEECH_ONSET_SAMPLES = 2;

/** Quiet for this long after speech ends the utterance. Long enough to
    survive the pause between clauses, short enough not to feel slow. */
export const SILENCE_HOLD_MS = 1100;

/** Speech shorter than this is a noise, not a sentence — measured from
    the first loud sample to the last, so it is genuine talking time. */
export const MIN_UTTERANCE_MS = 250;

/** Nothing said at all for this long ends the cycle quietly and lets
    the session re-arm, rather than recording an empty room forever. */
export const NO_SPEECH_TIMEOUT_MS = 9000;

/** Hard ceiling on one utterance. */
export const MAX_UTTERANCE_MS = 30000;

/** Capture constraints. Echo cancellation is the first line of defence
    against Cirrus hearing itself — the session closing the microphone
    during playback is the second, and the one actually relied on. */
export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Containers worth asking for, best first. Safari records MP4/AAC and
    supports nothing else; everything else records WebM/Opus. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/ogg;codecs=opus",
];

export const RECORDER_ERRORS = {
  denied: "Microphone access is off. Turn it on in your browser settings to use voice.",
  unavailable: "This browser can't record audio. Typing still works.",
  audio_capture: "No microphone is available.",
  insecure: "Voice needs a secure (https) connection.",
  unknown: "Voice input stopped unexpectedly.",
};

/** True on iPhone/iPad, including iPadOS pretending to be a Mac. */
export function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports a desktop UA; a touch-capable "Mac" is an iPad.
  return ua.includes("Macintosh") && (navigator.maxTouchPoints || 0) > 1;
}

/* Holding a live capture stream while an <audio> element plays puts iOS
   into its record-and-play audio session, which routes output to the
   receiver — Cirrus's reply comes out quiet and thin. So on iOS the
   stream is dropped for the duration of each reply and re-acquired
   after. Re-acquiring does not re-prompt once permission is granted.

   Everywhere else the stream is held across turns, which is both faster
   and what Stage 9 asked for. */
export const HOLD_STREAM_BETWEEN_TURNS = !isIOS();

export function recorderSupport() {
  if (typeof window === "undefined") return { available: false, reason: "unavailable" };
  if (!window.isSecureContext && window.location?.hostname !== "localhost") {
    return { available: false, reason: "insecure" };
  }
  if (!navigator?.mediaDevices?.getUserMedia) return { available: false, reason: "unavailable" };
  if (typeof window.MediaRecorder === "undefined") return { available: false, reason: "unavailable" };
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return { available: false, reason: "unavailable" };
  return { available: true, reason: null };
}

/** The first container this browser will actually record. */
function pickMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder) return "";
  const supported = window.MediaRecorder.isTypeSupported;
  if (typeof supported !== "function") return "";   // Safari ≤14 — let it choose
  for (const type of MIME_CANDIDATES) {
    try {
      if (supported.call(window.MediaRecorder, type)) return type;
    } catch {
      /* some engines throw on odd strings */
    }
  }
  return "";
}

function mapGetUserMediaError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "audio_capture";
  }
  if (name === "NotReadableError" || name === "TrackStartError") return "audio_capture";
  return "unknown";
}

/**
 * One recorded utterance at a time.
 *
 * `onTranscript(text, meta)` fires once per utterance that produced
 * words. `onEnd({delivered, reason, fatal})` fires exactly once per
 * cycle whatever happened, which is what a continuous session needs in
 * order to decide whether to listen again.
 */
export function useVoiceRecorder({ enabled = false, onTranscript, onEnd } = {}) {
  const support = useMemo(recorderSupport, []);
  const [state, setState] = useState(
    support.available ? RECORDER_STATES.IDLE : RECORDER_STATES.UNAVAILABLE,
  );
  const [error, setError] = useState(null);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  const streamRef = useRef(null);
  const ctxRef = useRef(null);        // AudioContext, kept across turns
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const vadTimer = useRef(null);
  const startingRef = useRef(false);
  const deniedRef = useRef(false);
  /* Guards the one-cycle-one-outcome rule. Incremented whenever a cycle
     ends for any reason, so a late `onstop` from an abandoned recorder
     cannot deliver a second transcript. */
  const cycleRef = useRef(0);
  const settledRef = useRef(true);

  /* ---------- teardown ---------- */

  const stopVad = () => {
    if (vadTimer.current) {
      clearInterval(vadTimer.current);
      vadTimer.current = null;
    }
  };

  const dropStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* already gone */
    }
    sourceRef.current = null;
    analyserRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();      // the call that drops the hardware capture
        } catch {
          /* already ended */
        }
      }
    }
  }, []);

  /** Stops the recorder without delivering anything. */
  const abandonRecorder = useCallback(() => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return;
    rec.ondataavailable = null;
    rec.onstop = null;
    rec.onerror = null;
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  /** Reports the end of a cycle exactly once. */
  const settle = useCallback((info) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onEndRef.current?.(info);
  }, []);

  /* ---------- level metering ---------- */

  const readLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }, []);

  /* ---------- the cycle ---------- */

  /**
   * Finishes the utterance and transcribes it.
   *
   * `deliver` false means the bytes are thrown away — a cancel, a
   * pause, a mode change. Nothing is sent anywhere in that case.
   */
  const finishCycle = useCallback(
    (deliver, quietReason = "silence") => {
      const cycle = cycleRef.current;
      stopVad();
      const rec = recorderRef.current;

      if (!rec || rec.state === "inactive") {
        abandonRecorder();
        if (!HOLD_STREAM_BETWEEN_TURNS) dropStream();
        setState((s) => (s === RECORDER_STATES.LISTENING ? RECORDER_STATES.IDLE : s));
        settle({ delivered: false, reason: quietReason });
        return;
      }

      if (!deliver) {
        abandonRecorder();
        chunksRef.current = [];
        if (!HOLD_STREAM_BETWEEN_TURNS) dropStream();
        setState((s) => (s === RECORDER_STATES.LISTENING ? RECORDER_STATES.IDLE : s));
        settle({ delivered: false, reason: quietReason });
        return;
      }

      rec.onstop = async () => {
        recorderRef.current = null;
        // A newer cycle started while this one was stopping: its bytes
        // belong to a conversation that has moved on.
        if (cycle !== cycleRef.current) return;

        const parts = chunksRef.current;
        chunksRef.current = [];
        const type = rec.mimeType || parts[0]?.type || "audio/webm";
        const blob = parts.length ? new Blob(parts, { type }) : null;

        /* The microphone is shut before the network call, not after.
           Cirrus is about to speak, and the one thing that must never
           be true is a live capture while its own voice is playing. */
        if (!HOLD_STREAM_BETWEEN_TURNS) dropStream();

        if (!blob || !blob.size) {
          setState(RECORDER_STATES.IDLE);
          settle({ delivered: false, reason: "silence" });
          return;
        }

        setState(RECORDER_STATES.TRANSCRIBING);
        const result = await transcribeAudio(blob);
        if (cycle !== cycleRef.current) return;   // abandoned mid-flight

        if (!result.ok) {
          setState(RECORDER_STATES.ERROR);
          setError({
            code: result.code,
            message: TRANSCRIBE_ERRORS[result.code] || TRANSCRIBE_ERRORS.unknown,
            detail: result.detail || null,
          });
          /* Not fatal: a failed transcription is one lost utterance,
             not a broken conversation. The session's error budget
             decides when to give up. */
          settle({ delivered: false, reason: result.code, fatal: false });
          return;
        }

        setState(RECORDER_STATES.IDLE);
        const text = (result.text || "").trim();
        if (!text) {
          // An empty transcript is not a message. Nothing is sent and
          // no action can follow from it.
          settle({ delivered: false, reason: "silence" });
          return;
        }
        setError(null);
        /* No confidence score comes back from transcription, so it is
           reported as unknown — never as high. The approval gate treats
           unknown exactly as it treats Safari's missing score. */
        onTranscriptRef.current?.(text, { confidence: null, low: false });
        settle({ delivered: true, reason: "transcript" });
      };

      try {
        rec.stop();
      } catch {
        abandonRecorder();
        setState(RECORDER_STATES.IDLE);
        settle({ delivered: false, reason: "unknown" });
      }
    },
    [abandonRecorder, dropStream, settle],
  );

  const finishRef = useRef(finishCycle);
  finishRef.current = finishCycle;

  /** Hard cancel: no transcript is delivered, nothing is sent. */
  const cancel = useCallback(() => {
    cycleRef.current += 1;
    stopVad();
    abandonRecorder();
    chunksRef.current = [];
    if (!HOLD_STREAM_BETWEEN_TURNS) dropStream();
    settledRef.current = true;      // a cancel owes no report
    setState((s) =>
      s === RECORDER_STATES.LISTENING || s === RECORDER_STATES.TRANSCRIBING
        ? RECORDER_STATES.IDLE
        : s,
    );
  }, [abandonRecorder, dropStream]);

  /** Graceful stop: whatever was recorded is transcribed. */
  const stop = useCallback(() => {
    if (!recorderRef.current) return;
    finishRef.current(true);
  }, []);

  /** Full teardown — stream included. Used by pause, end, mode change,
      unmount and tab hide, so the hardware never outlives the session. */
  const release = useCallback(() => {
    cycleRef.current += 1;
    settledRef.current = true;
    stopVad();
    abandonRecorder();
    chunksRef.current = [];
    dropStream();
    // Sweep anything any other module could still be holding.
    releaseMicrophone();
    setState((s) =>
      s === RECORDER_STATES.LISTENING || s === RECORDER_STATES.TRANSCRIBING
        ? RECORDER_STATES.IDLE
        : s,
    );
  }, [abandonRecorder, dropStream]);

  /**
   * Opens the microphone and begins an utterance.
   *
   * Returns the same shapes useVoiceInput returns, so the session
   * controller cannot tell the two engines apart.
   */
  const start = useCallback(() => {
    if (!enabled) return { ok: false, code: "disabled" };
    if (!support.available) {
      setState(RECORDER_STATES.UNAVAILABLE);
      setError({
        code: support.reason || "unavailable",
        message: RECORDER_ERRORS[support.reason] || RECORDER_ERRORS.unavailable,
      });
      return { ok: false, code: "unavailable" };
    }
    if (deniedRef.current) {
      setState(RECORDER_STATES.DENIED);
      setError({ code: "denied", message: RECORDER_ERRORS.denied });
      return { ok: false, code: "denied" };
    }
    // A second start while one is live must not open a second recorder.
    if (recorderRef.current || startingRef.current) return { ok: false, code: "already_listening" };

    startingRef.current = true;
    const cycle = ++cycleRef.current;
    settledRef.current = false;
    chunksRef.current = [];

    /* Everything below is asynchronous, but the *decision* to capture
       was made inside the user's tap on the first turn, which is what
       iOS grants permission and audio activation to. */
    (async () => {
      try {
        // The AudioContext is created once and kept: on iOS it can only
        // be unlocked inside a gesture, so closing it between turns
        // would need a new tap every time.
        if (!ctxRef.current) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          ctxRef.current = new AudioCtx();
        }
        if (ctxRef.current.state === "suspended") {
          try {
            await ctxRef.current.resume();
          } catch {
            /* resumes on the next gesture if this one was refused */
          }
        }

        if (!streamRef.current) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
          // Registered with the shared capture registry so the global
          // releaseMicrophone() sweep can stop it from any path.
          registerStream(stream);
          streamRef.current = stream;
        }
        if (cycle !== cycleRef.current) {     // cancelled while acquiring
          startingRef.current = false;
          dropStream();
          return;
        }

        if (!analyserRef.current) {
          const ctx = ctxRef.current;
          const source = ctx.createMediaStreamSource(streamRef.current);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.2;
          // Deliberately NOT connected to ctx.destination: routing the
          // microphone to the speakers is a feedback loop.
          source.connect(analyser);
          sourceRef.current = source;
          analyserRef.current = analyser;
        }

        const mimeType = pickMimeType();
        const rec = new window.MediaRecorder(
          streamRef.current,
          mimeType ? { mimeType } : undefined,
        );
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) chunksRef.current.push(e.data);
        };
        rec.onerror = () => {
          if (cycle !== cycleRef.current) return;
          setState(RECORDER_STATES.ERROR);
          setError({ code: "unknown", message: RECORDER_ERRORS.unknown });
          abandonRecorder();
          settle({ delivered: false, reason: "unknown", fatal: false });
        };
        rec.start();
        recorderRef.current = rec;
        startingRef.current = false;
        setState(RECORDER_STATES.LISTENING);
        setError(null);

        /* ---- end-of-speech detection ---- */
        const openedAt = Date.now();
        let onsetRun = 0;
        let onsetFirstAt = 0;      // first loud sample of the current run
        let speechStartedAt = 0;
        let lastLoudAt = 0;

        vadTimer.current = setInterval(() => {
          if (cycle !== cycleRef.current) {
            stopVad();
            return;
          }
          const now = Date.now();
          const rms = readLevel();

          if (rms >= SPEECH_RMS_THRESHOLD) {
            if (onsetRun === 0) onsetFirstAt = now;
            onsetRun++;
            if (!speechStartedAt && onsetRun >= SPEECH_ONSET_SAMPLES) {
              /* Backdated to the first loud sample, not to the one that
                 confirmed it. Confirmation costs a couple of samples,
                 and counting them as silence would make every utterance
                 measure shorter than it was. */
              speechStartedAt = onsetFirstAt;
            }
            if (speechStartedAt) lastLoudAt = now;
          } else {
            onsetRun = 0;
          }

          if (!speechStartedAt) {
            // Nobody is talking. End the cycle quietly so the session
            // can re-arm rather than recording an empty room.
            if (now - openedAt > NO_SPEECH_TIMEOUT_MS) finishRef.current(false, "silence");
            return;
          }

          if (now - speechStartedAt > MAX_UTTERANCE_MS) {
            finishRef.current(true);
            return;
          }
          if (now - lastLoudAt >= SILENCE_HOLD_MS) {
            /* How long they actually TALKED — first loud sample to
               last. Measuring from speech start to *now* would include
               the whole silence hold, which makes every cough look like
               a sentence and defeats the minimum entirely. */
            const spoken = lastLoudAt - speechStartedAt;
            // A blip too short to be a sentence is discarded rather
            // than sent for transcription.
            if (spoken < MIN_UTTERANCE_MS) finishRef.current(false, "silence");
            else finishRef.current(true);
          }
        }, VAD_INTERVAL_MS);
      } catch (err) {
        startingRef.current = false;
        const code = mapGetUserMediaError(err);
        if (code === "denied") deniedRef.current = true;
        dropStream();
        if (cycle !== cycleRef.current) return;
        setState(
          code === "denied"
            ? RECORDER_STATES.DENIED
            : code === "audio_capture"
            ? RECORDER_STATES.UNAVAILABLE
            : RECORDER_STATES.ERROR,
        );
        setError({ code, message: RECORDER_ERRORS[code] || RECORDER_ERRORS.unknown });
        settle({
          delivered: false,
          reason: code,
          fatal: code === "denied" || code === "audio_capture",
        });
      }
    })();

    // Optimistic: the async body reports any failure through onEnd, and
    // the session treats a fatal one as a reason to stop.
    return { ok: true };
  }, [enabled, support, abandonRecorder, dropStream, readLevel, settle]);

  /* Every way out of a capture session, all landing on release():
     `enabled` going false, unmount, and the tab being hidden or the
     page going away. iOS in particular will not always deliver a clean
     unload, so pagehide and visibilitychange both matter. */
  useEffect(() => {
    if (!enabled) release();
  }, [enabled, release]);

  useEffect(() => () => release(), [release]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onHide = () => {
      if (document.visibilityState === "hidden") release();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
    };
  }, [release]);

  const clearError = useCallback(() => setError(null), []);

  return {
    engine: "recorder",
    supported: support.available,
    state,
    listening: state === RECORDER_STATES.LISTENING,
    transcribing: state === RECORDER_STATES.TRANSCRIBING,
    // No live partial text exists with this engine: the words only
    // arrive once the utterance has been transcribed. The session shows
    // its own "Listening" copy rather than inventing a preview.
    interim: "",
    error,
    start,
    stop,
    cancel,
    release,
    clearError,
  };
}
