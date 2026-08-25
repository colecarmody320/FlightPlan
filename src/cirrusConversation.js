import { useCallback, useEffect, useMemo, useState } from "react";
import { CIRRUS_MODES, WAVEFORM_STATES } from "./cirrusShared.js";
import { CIRRUS_TASK_MODES } from "./cirrusPersonality.js";

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
export function useCirrusConversation({ mode, page, selectedObject } = {}) {
  const [state, setState] = useState(() => blankConversation({ mode, page }));

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
      clear,
    }),
    [state, addMessage, setTaskMode, setActiveTopic, setUnresolvedReferences, setPendingAction, setVoiceState, clear]
  );
}
