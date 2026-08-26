import { useCallback, useEffect, useRef, useState } from "react";

/* ============================================================
   CIRRUS — CONTINUOUS COMPANION SESSION (Stage 8)

   The hands-free loop:

     listen → transcript → turn → speak → listen → …

   WHAT THIS IS NOT. It is not a new conversation engine, a second
   action path, or a relaxed set of rules for voice. It owns one thing:
   deciding when the microphone should be open. The turn itself still
   runs through the same submit path typed text uses, so Stage 5
   validation, the Stage 6 approval gate and the completion guard all
   apply exactly as before — a spoken "delete that" raises the same
   approval card a typed one does.

   NEVER BOTH AT ONCE. The microphone is closed for the entire time
   Cirrus is speaking. Not muted, not ignored — closed. Otherwise the
   recognizer transcribes Cirrus and the loop feeds itself, which is
   both a runaway request loop and a very confusing conversation.

   RUNAWAY PROTECTION. A loop that restarts itself needs brakes that do
   not depend on anything going right:
     - one turn at a time, enforced by a lock rather than by timing
     - a floor on how quickly recognition may restart
     - an error budget, after which the session stops rather than
       retrying forever
     - an idle timeout, so a forgotten session does not hold the
       microphone indefinitely
     - a hard ceiling on session length

   iOS. Recognition and audio both want a user gesture. The session
   therefore starts from a real tap, which is where audio is unlocked;
   restarts afterwards reuse that activation. If a restart is refused
   anyway, the session ends and says so rather than silently appearing
   to listen.
   ============================================================ */

export const SESSION_STATES = {
  OFF: "off",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  ENDED: "ended",
};

/** Shortest gap between one recognition session ending and the next
    starting. Stops a failing recognizer from spinning. */
export const RESTART_DELAY_MS = 450;

/** Consecutive faults — not silences — before the session gives up. */
export const ERROR_BUDGET = 3;

/** No speech heard for this long ends the session. Matches the
    five-minute conversational idle timeout Cirrus was specified with. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** A ceiling on one continuous session regardless of activity. */
export const MAX_SESSION_MS = 30 * 60 * 1000;

export const END_REASONS = {
  USER: "user",
  IDLE: "idle",
  MAX_DURATION: "max_duration",
  ERRORS: "errors",
  DENIED: "denied",
  UNAVAILABLE: "unavailable",
  MODE: "mode",
};

export const END_MESSAGES = {
  [END_REASONS.IDLE]: "I've stopped listening — it went quiet for a while.",
  [END_REASONS.MAX_DURATION]: "I've ended the voice session. Start another whenever you like.",
  [END_REASONS.ERRORS]: "I've stopped listening — the microphone kept failing. Typing still works.",
  [END_REASONS.DENIED]: "I can't listen without microphone access. Typing still works.",
  [END_REASONS.UNAVAILABLE]: "This browser can't keep listening. Typing still works.",
};

/**
 * Drives the continuous conversation.
 *
 * `mic` and `tts` are the existing Stage 7 hooks, unchanged. `runTurn`
 * is the dock's own submit path; it must resolve only once the turn is
 * completely finished, speech included, because that resolution is what
 * re-opens the microphone.
 */
export function useCirrusSession({ enabled = false, mic, tts, runTurn, onEnded } = {}) {
  const [state, setState] = useState(SESSION_STATES.OFF);
  const [note, setNote] = useState(null);

  const activeRef = useRef(false);
  const turnLock = useRef(false);      // one turn in flight, ever
  const errorsRef = useRef(0);
  const startedAtRef = useRef(0);
  const lastVoiceRef = useRef(0);
  const restartTimer = useRef(null);
  const idleTimer = useRef(null);

  // Latest values, so the loop's callbacks never close over stale ones.
  const micRef = useRef(mic);
  micRef.current = mic;
  const ttsRef = useRef(tts);
  ttsRef.current = tts;
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const clearTimers = () => {
    if (restartTimer.current) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  };

  /** Ends the session and releases everything. Safe to call twice. */
  const end = useCallback((reason = END_REASONS.USER) => {
    const wasActive = activeRef.current;
    activeRef.current = false;
    clearTimers();
    // Release before anything else: whatever the reason, the microphone
    // must not outlive the session by even a render.
    micRef.current?.release?.();
    ttsRef.current?.stop?.();
    setState(SESSION_STATES.OFF);
    if (!wasActive) return;
    const message = END_MESSAGES[reason] || null;
    setNote(message);
    onEndedRef.current?.(reason, message);
  }, []);

  const armIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (activeRef.current) end(END_REASONS.IDLE);
    }, IDLE_TIMEOUT_MS);
  }, [end]);

  /**
   * Opens the microphone again, if every condition still holds.
   *
   * Deliberately paranoid: each guard here is a way the loop could
   * otherwise run away or talk over itself.
   */
  const listenAgain = useCallback(
    (delay = RESTART_DELAY_MS) => {
      if (!activeRef.current) return;
      if (restartTimer.current) return;         // one pending restart
      if (turnLock.current) return;             // a turn is still running
      if (Date.now() - startedAtRef.current > MAX_SESSION_MS) {
        end(END_REASONS.MAX_DURATION);
        return;
      }

      restartTimer.current = setTimeout(() => {
        restartTimer.current = null;
        if (!activeRef.current || turnLock.current) return;
        // Never open the microphone while audio is still playing.
        if (ttsRef.current?.speaking) {
          listenAgain(200);
          return;
        }
        const r = micRef.current?.start?.();
        if (r?.ok) {
          setState(SESSION_STATES.LISTENING);
          return;
        }
        if (r?.code === "already_listening") {
          setState(SESSION_STATES.LISTENING);
          return;
        }
        if (r?.code === "denied") {
          end(END_REASONS.DENIED);
          return;
        }
        if (r?.code === "unavailable") {
          end(END_REASONS.UNAVAILABLE);
          return;
        }
        // Anything else — including a restart iOS refused for want of a
        // gesture — counts against the budget rather than looping.
        errorsRef.current += 1;
        if (errorsRef.current >= ERROR_BUDGET) end(END_REASONS.ERRORS);
        else listenAgain(RESTART_DELAY_MS * 2);
      }, delay);
    },
    [end]
  );

  /** One complete exchange, from transcript to the end of the reply. */
  const handleTranscript = useCallback(
    async (text, meta) => {
      if (!activeRef.current) return;
      // A second transcript arriving mid-turn is dropped rather than
      // queued: it would otherwise be answered out of order.
      if (turnLock.current) return;
      turnLock.current = true;
      errorsRef.current = 0;             // real speech clears the budget
      lastVoiceRef.current = Date.now();
      armIdleTimer();

      // Belt and braces: recognition has already ended itself by now,
      // but the microphone must be provably shut before Cirrus speaks.
      micRef.current?.cancel?.();
      setState(SESSION_STATES.THINKING);

      try {
        await runTurnRef.current?.(text, meta);
      } catch {
        // A failed turn is not a reason to abandon the conversation.
        errorsRef.current += 1;
      } finally {
        turnLock.current = false;
        if (activeRef.current) {
          if (errorsRef.current >= ERROR_BUDGET) end(END_REASONS.ERRORS);
          else listenAgain();
        }
      }
    },
    [armIdleTimer, end, listenAgain]
  );

  /** Recognition finished without producing anything. */
  const handleRecognitionEnd = useCallback(
    (info) => {
      if (!activeRef.current) return;
      if (info?.delivered) return;       // handleTranscript owns that path
      if (info?.fatal) {
        end(info.reason === "denied" ? END_REASONS.DENIED : END_REASONS.UNAVAILABLE);
        return;
      }
      // Silence is ordinary in a hands-free conversation and must not
      // burn the error budget; anything else is a genuine fault.
      if (info?.reason && info.reason !== "silence" && info.reason !== "no_speech") {
        errorsRef.current += 1;
        if (errorsRef.current >= ERROR_BUDGET) {
          end(END_REASONS.ERRORS);
          return;
        }
      }
      if (!turnLock.current) listenAgain();
    },
    [end, listenAgain]
  );

  /**
   * Begins a session. Must be called from a real user gesture: that is
   * what unlocks audio on iOS and grants the first recognition its
   * activation.
   */
  const start = useCallback(() => {
    if (!enabled) return { ok: false, code: "disabled" };
    if (activeRef.current) return { ok: true, code: "already_running" };
    if (!micRef.current?.supported) {
      setNote(END_MESSAGES[END_REASONS.UNAVAILABLE]);
      return { ok: false, code: "unavailable" };
    }

    activeRef.current = true;
    turnLock.current = false;
    errorsRef.current = 0;
    startedAtRef.current = Date.now();
    lastVoiceRef.current = Date.now();
    setNote(null);

    // Inside the gesture, while we still have activation.
    ttsRef.current?.unlock?.();
    armIdleTimer();

    const r = micRef.current?.start?.();
    if (!r?.ok && r?.code !== "already_listening") {
      activeRef.current = false;
      clearTimers();
      if (r?.code === "denied") setNote(END_MESSAGES[END_REASONS.DENIED]);
      setState(SESSION_STATES.OFF);
      return r || { ok: false, code: "unknown" };
    }
    setState(SESSION_STATES.LISTENING);
    return { ok: true };
  }, [enabled, armIdleTimer]);

  // Leaving Companion, closing the panel, or unmounting ends it at once.
  useEffect(() => {
    if (!enabled && activeRef.current) end(END_REASONS.MODE);
  }, [enabled, end]);

  useEffect(() => () => {
    activeRef.current = false;
    clearTimers();
    micRef.current?.release?.();
    ttsRef.current?.stop?.();
  }, []);

  // Reflect what is actually happening, so the waveform cannot show
  // "listening" while the microphone is shut.
  useEffect(() => {
    if (!activeRef.current) return;
    if (tts?.speaking) setState(SESSION_STATES.SPEAKING);
    else if (turnLock.current) setState(SESSION_STATES.THINKING);
    else if (mic?.listening) setState(SESSION_STATES.LISTENING);
  }, [tts?.speaking, mic?.listening]);

  return {
    state,
    note,
    active: activeRef.current,
    running: state !== SESSION_STATES.OFF,
    start,
    end,
    handleTranscript,
    handleRecognitionEnd,
    clearNote: useCallback(() => setNote(null), []),
  };
}
