import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CIRRUS_MODES, WAVEFORM_STATES } from "./cirrusShared.js";
import { CIRRUS_TASK_MODES } from "./cirrusPersonality.js";
import { sendCirrusMessage } from "./cirrusService.js";

/* ============================================================
   CIRRUS — conversation state architecture
   In-memory only (React state) — never written to flightplan_data,
   never written to localStorage. This resets on refresh by design;
   transcript persistence is a decision for a later stage, not this
   one. No provider call happens anywhere in this file.
   ============================================================ */

// Hard cap on how many turns we keep in memory. Once trimmed, the
// dropped messages are handed to summarizeOlderMessages() so a later
// stage can fold them into a running summary instead of losing them
// outright — for now that hook is a no-op.
const MAX_MESSAGES = 40;

let _id = 0;
const nextMessageId = () => `cirrus-msg-${++_id}`;

export function trimMessages(messages, max = MAX_MESSAGES) {
  if (messages.length <= max) return { kept: messages, dropped: [] };
  const cut = messages.length - max;
  return { kept: messages.slice(cut), dropped: messages.slice(0, cut) };
}

// Placeholder for a later stage: fold messages trimmed out of the
// working set into a running text summary instead of discarding them.
// Intentionally inert here — no model call belongs in this stage.
export function summarizeOlderMessages(droppedMessages, priorSummary = null) {
  if (!droppedMessages.length) return priorSummary;
  return priorSummary;
}

function blankConversation({ mode, page } = {}) {
  return {
    messages: [],
    summary: null,
    page: page || "home",
    selectedObject: null,
    activeTopic: null,
    unresolvedReferences: [],
    pendingAction: null,
    mode: mode || CIRRUS_MODES.OFF,
    taskMode: CIRRUS_TASK_MODES.NORMAL,
    voiceState: WAVEFORM_STATES.READY,
    // Transport state for an in-flight turn. Ephemeral like the rest
    // of this object — never persisted.
    sending: false,
    error: null,
  };
}

/**
 * Owns Cirrus's ephemeral conversation state: transcript, current
 * page/selection, active topic, unresolved references, a pending
 * action awaiting approval, and mode/task-mode/voice-state. Callers
 * feed in the externally-owned facts (Cirrus mode from data.cirrus,
 * the app's current tab, the current selection) and this hook keeps
 * them in sync without resetting the conversation itself.
 */
export function useCirrusConversation({ mode, page, selectedObject, getRequestExtras } = {}) {
  const [state, setState] = useState(() => blankConversation({ mode, page }));

  // Mirrors state so send() can read the current transcript/context
  // without re-creating itself on every keystroke-driven render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Supplies the read-only app context and action catalogue at send
  // time. Held in a ref so `send` does not have to be rebuilt whenever
  // the user's data changes.
  const extrasRef = useRef(getRequestExtras);
  extrasRef.current = getRequestExtras;

  useEffect(() => {
    setState((s) => (s.mode === mode ? s : { ...s, mode }));
  }, [mode]);

  useEffect(() => {
    setState((s) => (s.page === page ? s : { ...s, page }));
  }, [page]);

  useEffect(() => {
    setState((s) => (s.selectedObject === selectedObject ? s : { ...s, selectedObject }));
  }, [selectedObject]);

  const addMessage = useCallback((role, content) => {
    if (!content || !content.trim()) return;
    setState((s) => {
      const raw = [...s.messages, { id: nextMessageId(), role, content: content.trim(), at: Date.now() }];
      const { kept, dropped } = trimMessages(raw);
      const summary = dropped.length ? summarizeOlderMessages(dropped, s.summary) : s.summary;
      return { ...s, messages: kept, summary };
    });
  }, []);

  const setTaskMode = useCallback((taskMode) => {
    setState((s) => ({ ...s, taskMode }));
  }, []);

  const setActiveTopic = useCallback((activeTopic) => {
    setState((s) => ({ ...s, activeTopic }));
  }, []);

  const setUnresolvedReferences = useCallback((unresolvedReferences) => {
    setState((s) => ({ ...s, unresolvedReferences }));
  }, []);

  const setPendingAction = useCallback((pendingAction) => {
    setState((s) => ({ ...s, pendingAction }));
  }, []);

  const setVoiceState = useCallback((voiceState) => {
    setState((s) => ({ ...s, voiceState }));
  }, []);

  const clearError = useCallback(() => {
    setState((s) => (s.error === null ? s : { ...s, error: null }));
  }, []);

  /**
   * One conversational turn: append the user's message, ask the
   * backend, append the reply or record the error. The reply is text
   * that gets displayed — it is never interpreted, and no branch here
   * writes to application data.
   */
  const send = useCallback(
    async (text) => {
      const trimmed = (text || "").trim();
      if (!trimmed) return { ok: false, code: "empty" };

      const snapshot = stateRef.current;
      if (snapshot.sending) return { ok: false, code: "busy" }; // one in-flight turn at a time
      // OFF means zero requests — enforced here as well as in the
      // service, so no call path can reach the network while off.
      if (!snapshot.mode || snapshot.mode === CIRRUS_MODES.OFF) {
        return { ok: false, code: "off" };
      }

      // History as it stood *before* this message; the new message is
      // sent separately as `message`.
      const history = snapshot.messages.map((m) => ({ role: m.role, content: m.content }));

      addMessage("user", trimmed);
      setState((s) => ({
        ...s,
        sending: true,
        error: null,
        voiceState: WAVEFORM_STATES.THINKING,
      }));

      let extras = {};
      try {
        extras = extrasRef.current ? extrasRef.current(trimmed) || {} : {};
      } catch {
        // Context is an enhancement. If building it fails, Cirrus still
        // answers — just without the extra facts.
        extras = {};
      }

      const result = await sendCirrusMessage({
        message: trimmed,
        history,
        mode: snapshot.mode,
        page: snapshot.page,
        selectedObject: snapshot.selectedObject,
        activeTopic: snapshot.activeTopic,
        taskMode: snapshot.taskMode,
        appContext: extras.appContext || null,
        actions: extras.actions || null,
      });

      if (result.ok) {
        addMessage("assistant", result.reply);
        setState((s) => ({
          ...s,
          sending: false,
          error: null,
          voiceState: WAVEFORM_STATES.READY,
        }));
        // Returned so a caller can speak the reply. The transcript is
        // already updated either way — nothing downstream can delay or
        // suppress the text by acting on this.
        return {
          ok: true,
          reply: result.reply,
          action: result.action || null,
          actionChannel: Boolean(result.actionChannel),
        };
      }

      // A failure leaves the transcript and every byte of application
      // data exactly as it was. The user's message stays on screen.
      setState((s) => ({
        ...s,
        sending: false,
        // `detail` is the backend's own description of the failure
        // (e.g. which status the provider returned). Kept so the UI can
        // show the actual cause rather than only the friendly summary.
        error: { code: result.code, message: result.message, detail: result.detail },
        voiceState: WAVEFORM_STATES.READY,
      }));
      return { ok: false, code: result.code };
    },
    [addMessage]
  );

  // Clears the transcript/topic/pending action but keeps mode/page/
  // selection, since those are still externally true.
  const clear = useCallback(() => {
    setState((s) => ({
      ...blankConversation({ mode: s.mode, page: s.page }),
      selectedObject: s.selectedObject,
    }));
  }, []);

  return useMemo(
    () => ({
      ...state,
      addMessage,
      setTaskMode,
      setActiveTopic,
      setUnresolvedReferences,
      setPendingAction,
      setVoiceState,
      clearError,
      send,
      clear,
    }),
    [
      state,
      addMessage,
      setTaskMode,
      setActiveTopic,
      setUnresolvedReferences,
      setPendingAction,
      setVoiceState,
      clearError,
      send,
      clear,
    ]
  );
}
