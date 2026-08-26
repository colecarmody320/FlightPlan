import React, { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { CIRRUS_MODES, WAVEFORM_STATES } from "./cirrusShared.js";
import { useCirrusConversation } from "./cirrusConversation.js";
import {
  createApprovalManager,
  describeProposal,
  classifyUtterance,
  verifyClaim,
  ROUTES,
} from "./cirrusApproval.js";
import { createActionHistory, listActions } from "./cirrusActions.js";
import { buildCirrusContext } from "./cirrusContext.js";
import {
  googleGetEvent,
  googleCreateEvent,
  googleUpdateEvent,
  googleDeleteEvent,
  invalidateGoogleCalendar,
  localTimeZone,
} from "./googleCalendar.js";
import { useVoiceInput, SPEECH_STATES } from "./cirrusSpeech.js";
import { useCirrusVoice, diagnoseVoice } from "./cirrusVoice.js";
import { useCirrusSession, SESSION_STATES } from "./cirrusSession.js";
import { CIRRUS_LIMIT_CODES } from "./cirrusService.js";

/* ============================================================
   CIRRUS — personal assistant layer
   Self-contained, like aviation.jsx. Inherits the .hub palette and
   cabin lighting via CSS variables. Stage 2 adds the centralized
   personality/prompt architecture (cirrusPersonality.js) and the
   ephemeral conversation-state hook (cirrusConversation.js) that
   this component now consumes instead of hardcoding UI state. No
   provider calls (Gemini/ElevenLabs/Calendar) are wired in yet —
   those land in later stages behind the allowlisted-action/permission
   gate described in the project brief. FlightPlan must work
   identically with this module removed entirely; nothing here
   touches app data outside the `cirrus` key. Panel open/collapsed
   state is still NOT persisted — it's ephemeral UI, kept separate
   from voice-session state, which now lives on the conversation
   object (`voiceState`) rather than being hardcoded per call site.
   ============================================================ */

export { CIRRUS_MODES, WAVEFORM_STATES };

const MODE_ORDER = [CIRRUS_MODES.OFF, CIRRUS_MODES.QUIET, CIRRUS_MODES.COMPANION];
const MODE_LABEL = {
  [CIRRUS_MODES.OFF]: "Off",
  [CIRRUS_MODES.QUIET]: "Quiet",
  [CIRRUS_MODES.COMPANION]: "Companion",
};

/* ---------- persisted state ---------- */
export function blankCirrus() {
  return { mode: CIRRUS_MODES.OFF };
}

// Additive only — an older or partial `data.cirrus` (or none at all)
// still resolves to a valid, safe-default state. Never replaces
// anything else on `data`.
export function migrateCirrus(d) {
  return { cirrus: { ...blankCirrus(), ...(d?.cirrus || {}) } };
}

/* ============================================================
   WAVEFORM
   Six bars, height/color/motion driven entirely by `state`. This is
   Cirrus's whole visual identity — no avatar, no orb, no bubble.
   ============================================================ */
export function Waveform({ state = WAVEFORM_STATES.READY, size = 20 }) {
  const bars = 6;
  return (
    <svg
      className={`cirrus-wave cirrus-wave-${state}`}
      viewBox="0 0 60 24"
      width={size * 2.5}
      height={size}
      role="img"
      aria-label={`Cirrus: ${state}`}
    >
      {Array.from({ length: bars }).map((_, i) => (
        <rect
          key={i}
          className="cirrus-bar"
          x={i * 10 + 2}
          y="9"
          width="4"
          height="6"
          rx="2"
          style={{ animationDelay: `${i * 0.09}s` }}
        />
      ))}
    </svg>
  );
}

/* ============================================================
   HEADER CONTROL + PANEL
   `open`/`setOpen` are owned by the caller (CollegeHub) so the
   keyboard shortcut and the Home strip can reach the same state.
   ============================================================ */

/* ============================================================
   APPROVAL CARD (Stage 6)

   The visible half of the approval gate. It exists so approval is
   never only conversational: a mis-heard "yes" is not the sole route
   to a destructive change, and the user can always see exactly what
   would happen and press Cancel instead.

   Everything it renders comes from `describeProposal`, which reads
   current application data — not from anything the model said. If the
   record has changed or vanished since the proposal, the card says so
   rather than showing a stale promise.
   ============================================================ */
export function ApprovalCard({ pending, data, onApprove, onCancel }) {
  if (!pending) return null;
  const d = describeProposal(pending, data);
  if (!d) return null;

  const seconds = Math.max(0, pending.secondsRemaining || 0);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const destructive = d.verb === "Delete";

  return (
    <div className={destructive ? "cirrus-approval danger" : "cirrus-approval"} role="alertdialog"
         aria-label="Pending change">
      <div className="cirrus-approval-head">
        <span className="cirrus-approval-tag">Pending change</span>
        <span className="cirrus-approval-clock" aria-live="off" title="Approval expires">
          {clock}
        </span>
      </div>

      <p className="cirrus-approval-action">
        {d.verb} &middot; {d.target}
      </p>

      {d.changes.length > 0 && (
        <ul className="cirrus-approval-changes">
          {d.changes.map((c) => (
            <li key={c.field}>
              <span className="cirrus-field">{c.field}</span>
              <span className="cirrus-was">{formatValue(c.current)}</span>
              <span aria-hidden="true">→</span>
              <span className="cirrus-will">{formatValue(c.proposed)}</span>
            </li>
          ))}
        </ul>
      )}

      {d.effect && <p className="cirrus-approval-effect">{d.effect}</p>}
      {d.caution && <p className="cirrus-approval-caution">{d.caution}</p>}
      {!d.targetStillExists && (
        <p className="cirrus-approval-caution">
          That record is no longer there. Approving now will do nothing.
        </p>
      )}

      <div className="cirrus-approval-actions">
        <button type="button" className="cirrus-approve" onClick={onApprove}>
          Approve
        </button>
        <button type="button" className="cirrus-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="cirrus-note dim">
        Nothing changes until you approve. Saying no, or waiting, leaves it alone.
      </p>
    </div>
  );
}

/* Voice failures that happen entirely in the browser. The Edge
   Function has nothing to add about these, so no diagnostic control is
   offered for them. */
const CLIENT_SIDE_TTS_CODES = new Set(["playback_blocked", "disabled", "superseded", "empty_audio"]);

/* What Cirrus says after an action actually ran. Built from the
   registry's own result rather than from anything the model claimed, so
   it can only ever report what really happened. */
function describeOutcome(outcome) {
  const r = outcome?.result || {};
  switch (outcome?.action) {
    case "create_google_calendar_event":
      return `Added "${r.title}" on ${r.date}${r.when && r.when !== "—" ? `, ${r.when}` : ""}.`;
    case "update_google_calendar_event":
      return `Updated "${r.target?.title || "that event"}"${r.target?.when && r.target.when !== "—" ? ` — now ${r.target.when}` : ""}.`;
    case "delete_google_calendar_event":
      return `Removed "${r.target?.title || "that event"}" from your calendar.`;
    default:
      return `Done${r.applied ? ` — ${r.applied}` : ""}.`;
  }
}

const formatValue = (v) =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "boolean"
    ? v
      ? "yes"
      : "no"
    : String(v).length > 60
    ? `${String(v).slice(0, 60)}…`
    : String(v);

export function CirrusDock({ data, update, open, setOpen, page, selectedObject, helpers, google }) {
  const mode = data?.cirrus?.mode || CIRRUS_MODES.OFF;
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState("");
  const panelRef = useRef(null);
  /* Built fresh for each turn from current data, so Cirrus answers from
     what the user actually has rather than asking them to restate it —
     and so an event can be identified by description. Read-only: the
     context builders never touch `update`. */
  const getRequestExtras = useCallback(
    (request) => {
      const built = buildCirrusContext({
        data,
        helpers,
        request,
        page,
        selectedObject,
        externalEvents: google?.events || [],
      });
      return { appContext: built?.context || null, actions: listActions() };
    },
    [data, helpers, page, selectedObject, google?.events]
  );

  const conversation = useCirrusConversation({ mode, page, selectedObject, getRequestExtras });

  /* ---------- approval gate (Stage 6) ----------
     Session-local and in memory. A reload drops any pending change,
     which is the safe direction to fail: the change simply doesn't
     happen. Nothing about it is written to flightplan_data. */
  const historyRef = useRef(null);
  if (!historyRef.current) historyRef.current = createActionHistory();
  const approvalRef = useRef(null);
  if (!approvalRef.current) approvalRef.current = createApprovalManager({ history: historyRef.current });

  const [pending, setPending] = useState(null);

  /* ---------- voice (Stage 7) ----------
     Mode behaviour is the one already documented for Cirrus, not a new
     one: OFF has no microphone and no speech; QUIET is typed, with no
     microphone and no spoken responses; COMPANION is where voice lives
     and starts from one deliberate tap. `voiceAllowed` gates both
     modules at construction, so in OFF and QUIET the microphone cannot
     be opened and no ElevenLabs request can be made — not merely
     hidden in the UI. */
  /* Voice is live only while Companion is selected AND the panel is
     open. The dock's toggle button stays mounted when the panel is
     closed, so without the `open` term a session started here would
     keep the microphone after the panel was dismissed — which is
     exactly what it did. */
  const voiceAllowed = mode === CIRRUS_MODES.COMPANION && open;
  // Set by the first deliberate mic tap. Until then Cirrus stays silent
  // even in Companion, so typing never unexpectedly starts talking.
  const [voiceSession, setVoiceSession] = useState(false);
  const [micNote, setMicNote] = useState(null);
  const [voiceReport, setVoiceReport] = useState(null);

  const tts = useCirrusVoice({ enabled: voiceAllowed });
  const ttsRef = useRef(tts);
  ttsRef.current = tts;
  // Assigned further down, once useVoiceInput has run. Held in a ref so
  // setMode and the close/unmount paths can release synchronously.
  const micRef = useRef(null);

  useEffect(() => {
    if (!voiceAllowed) {
      setVoiceSession(false);
      setMicNote(null);
      micRef.current?.release();
      ttsRef.current?.stop();
    }
  }, [voiceAllowed]);

  // Unmounting the dock entirely — signing out, or the app tearing
  // down — releases capture and stops playback too.
  useEffect(
    () => () => {
      micRef.current?.release();
      ttsRef.current?.stop();
    },
    []
  );

  /* The Google Calendar client an action runs against.

     Injected rather than imported by the action registry, the same way
     app helpers are, so the registry stays free of network code and the
     tests can drive a fake provider. The events list is whatever the
     calendar is currently showing, which is what makes "my study
     session tomorrow" resolvable to a real event id. */
  const googleRuntime = useMemo(
    () => ({
      connected: Boolean(google?.connected),
      events: google?.events || [],
      calendars: google?.calendars || [],
      selected: google?.selected || [],
      timeZone: localTimeZone(),
      getEvent: googleGetEvent,
      createEvent: googleCreateEvent,
      updateEvent: googleUpdateEvent,
      deleteEvent: googleDeleteEvent,
      // Pulls the change into the Calendar tab and Home's week strip at
      // once, instead of leaving them stale until the next poll.
      invalidate: invalidateGoogleCalendar,
    }),
    [google?.connected, google?.events, google?.calendars, google?.selected]
  );

  // `data` and `update` change identity on every save, so the runtime is
  // read fresh at call time rather than captured when a proposal is made.
  const runtimeRef = useRef({ data, update, helpers, google: googleRuntime });
  runtimeRef.current = { data, update, helpers, google: googleRuntime };

  const syncPending = useCallback(() => {
    setPending(approvalRef.current.getPending());
  }, []);

  /* The one door a structured action may enter by.

     Everything Cirrus proposes arrives here, and the approval manager
     decides what happens: a read or a create runs, and an edit or a
     delete becomes a pending transaction the user has to approve. The
     model's own opinion about permission is discarded before this
     point and is not consulted after it. */
  const proposeAction = useCallback(
    async (intent) => {
      const result = await approvalRef.current.propose(intent, runtimeRef.current);
      syncPending();
      return result;
    },
    [syncPending]
  );

  // Ticks the countdown and retires the transaction the moment the
  // window closes, so the card can never invite an approval that would
  // be refused.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(syncPending, 1000);
    return () => clearInterval(t);
  }, [pending, syncPending]);

  /* Everything Cirrus says goes through here: it always lands in the
     transcript, and is spoken only when a voice session is live. Speech
     is strictly additive — if it fails, the line is already on screen. */
  const sayRef = useRef(null);
  sayRef.current = (text) => {
    conversation.addMessage("assistant", text);
    if (voiceAllowed && voiceSession) {
      // Returned, not awaited here: callers that need to know when
      // Cirrus has stopped talking (the continuous loop does, so it can
      // reopen the microphone) await it; everyone else ignores it and
      // the line is on screen regardless.
      return ttsRef.current.speak(text);
    }
    return Promise.resolve({ ok: false, code: "disabled" });
  };
  const say = useCallback((text) => sayRef.current(text), []);

  const resolveApproval = useCallback(
    async (input) => {
      const result = await approvalRef.current.resolve(input, runtimeRef.current);
      syncPending();
      if (result.status === "ambiguous") return result; // caller decides what to say
      const said =
        result.status === "success"
          ? // Same description an auto-executed action gets, so an
            // approved change is reported as specifically as an
            // immediate one — and always from the registry's result.
            describeOutcome(result)
          : result.status === "rejected"
          ? "Left unchanged."
          : result.status === "no_pending_action"
          ? "There's nothing waiting for approval."
          : result.message || "That couldn't be completed.";
      await say(said);
      return result;
    },
    [say, syncPending]
  );

  useEffect(() => {
    if (!open) setCollapsed(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const setMode = (m) => {
    /* Release before the state change, not as a consequence of it.
       Waiting for `enabled` to flip through a render leaves the
       microphone open across that gap, and OFF and QUIET must never
       have it open for any interval at all. */
    if (m !== CIRRUS_MODES.COMPANION) {
      sessionRef.current?.end?.("mode");
      micRef.current?.release();
      ttsRef.current?.stop();
      // A voice error is noise once voice is deliberately off; Quiet
      // should not carry a complaint about a subsystem it never uses.
      ttsRef.current?.clearError?.();
      setVoiceReport(null);
      setVoiceSession(false);
    }
    update((d) => ({ ...d, cirrus: { ...(d.cirrus || blankCirrus()), mode: m } }));
  };

  /* ============================================================
     THE SUBMIT PATH

     Typed text and a speech transcript are the same thing by the time
     they reach here: a string. There is no voice branch below this
     line — no voiceApproval(), no voice-only action route, no relaxed
     rule because the user "sounds certain". Voice is a transport that
     produces the argument to this function, nothing more.

     `spoken` only ever makes Cirrus more cautious: it gates on
     transcription confidence before letting a heard word resolve a
     destructive change.
     ============================================================ */
  const submitText = useCallback(
    async (raw, { spoken = false, lowConfidence = false } = {}) => {
      const text = (raw || "").trim();
      if (conversation.sending) return;

      const { route } = classifyUtterance({
        text,
        hasPending: Boolean(approvalRef.current.getPending()),
        spoken,
        lowConfidence,
      });

      // An empty or whitespace-only transcript is not a message. Nothing
      // is sent and no action can follow from it.
      if (route === ROUTES.IGNORE) return;

      if (route === ROUTES.REFUSE_BULK) {
        conversation.addMessage("user", text);
        await say(
          "I won't do that. I can only change one record at a time, and only with your approval each time. If you want something removed, name it specifically."
        );
        return;
      }

      if (route === ROUTES.LOW_CONFIDENCE) {
        // The transaction stays pending and the buttons remain. This is
        // stricter than the typed path, never looser.
        conversation.addMessage("user", text);
        await say("I'm not confident I heard that correctly. Say it again, or use Approve or Cancel.");
        return;
      }

      if (route === ROUTES.RESOLVE_APPROVAL) {
        conversation.addMessage("user", text);
        await resolveApproval(text);
        return;
      }

      // CONVERSE. Note that an ambiguous answer to a pending change
      // lands here: the change stays pending and "yes, but which card?"
      // asks rather than executes.
      const result = await conversation.send(text);

      /* Hitting a limit is not a fault to retry through. Reported to
         the caller so a hands-free session stops rather than listening
         again and inviting another rejected request. */
      if (result && !result.ok && CIRRUS_LIMIT_CODES.has(result.code)) {
        return { limited: true, code: result.code };
      }
      let replyAudio = null;
      if (result?.ok && voiceAllowed && voiceSession) {
        // The reply is already rendered; speaking it is a separate,
        // failable step that cannot delay or discard the text. The
        // promise is held so the turn can end when speech does.
        replyAudio = ttsRef.current.speak(result.reply);
      }

      if (!result?.ok) return;

      /* If Cirrus proposed something, run it through the gate. The
         reply text is already on screen and stays there whatever
         happens next — a rejected or impossible action changes what
         Cirrus says afterwards, never what it already said. */
      let outcome = null;
      if (result.action) {
        outcome = await proposeAction(result.action);
        // The reply's own audio finishes before an outcome line
        // starts, so the two never overlap.
        if (replyAudio) { await replyAudio; replyAudio = null; }
        if (outcome.status === "success") {
          await say(describeOutcome(outcome));
        } else if (outcome.status === "error" || outcome.status === "unsupported") {
          // Includes "which one did you mean?" — Cirrus asks rather
          // than picking, and nothing has been changed.
          await say(outcome.message || "I couldn't do that.");
        } else if (outcome.status === "pending_exists") {
          await say(outcome.message);
        }
        // approval_required needs no line here: the card says it.
      }

      /* Last line of defence. If the reply claimed a change but no
         action ran, contradict it. Only this code knows what really
         happened, so only this code can be trusted to say so. */
      const correction = verifyClaim({
        reply: result.reply,
        action: result.action,
        executed: outcome,
        actionChannel: result.actionChannel,
      });
      if (correction) { if (replyAudio) { await replyAudio; replyAudio = null; } await say(correction); }
      if (replyAudio) await replyAudio;
    },
    [conversation, say, resolveApproval, proposeAction, voiceAllowed, voiceSession]
  );

  const sendDraft = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || conversation.sending) return;
    setDraft("");
    submitText(text);
  };

  /* A transcript always appears in the conversation before anything
     acts on it — `submitText` renders the user message on every branch,
     and `conversation.send` does so on the ordinary one. Nothing is
     ever sent that the user cannot see, and no transcript is invented. */
  /* The unit of work the continuous session repeats. It is the same
     function typed input calls — there is no voice-only turn — and it
     resolves only once everything, speech included, has finished. */
  const runTurn = useCallback(
    (text, meta) => submitText(text, { spoken: true, lowConfidence: Boolean(meta?.low) }),
    [submitText]
  );

  const sessionRef = useRef(null);

  /* A transcript goes to the session while one is running, so the loop
     controls when the microphone reopens; otherwise straight to the
     turn, which is the single-tap behaviour from Stage 7. */
  const handleTranscript = useCallback(
    (text, meta) => {
      const session = sessionRef.current;
      if (session?.running) session.handleTranscript(text, meta);
      else runTurn(text, meta);
    },
    [runTurn]
  );

  const handleRecognitionEnd = useCallback((info) => {
    sessionRef.current?.handleRecognitionEnd?.(info);
  }, []);

  const mic = useVoiceInput({
    enabled: voiceAllowed,
    onTranscript: handleTranscript,
    onEnd: handleRecognitionEnd,
  });
  micRef.current = mic;

  const session = useCirrusSession({
    enabled: voiceAllowed,
    mic,
    tts,
    runTurn,
    onEnded: (reason, message) => {
      // The session says why it stopped, in the transcript, so a
      // conversation never just goes quiet without explanation.
      if (message) conversation.addMessage("assistant", message);
    },
  });
  sessionRef.current = session;

  /* One control, two jobs: stop if listening, otherwise start.
     `unlock()` runs synchronously inside the tap because iOS grants
     audio permission to the gesture, not to the later network
     continuation that actually has something to play. */
  /* One control, one meaning: start the conversation, or end it.
     Both branches run inside the tap, which is what gives iOS the user
     activation that audio playback and recognition both want. */
  const toggleMic = useCallback(() => {
    if (!voiceAllowed) return;
    setMicNote(null);
    session.clearNote();

    if (session.running) {
      session.end();
      return;
    }

    ttsRef.current.unlock();
    ttsRef.current.stop();
    if (!voiceSession) setVoiceSession(true);

    const r = session.start();
    if (!r.ok) {
      if (r.code === "unavailable") setMicNote("This browser can't listen continuously.");
      else if (r.code === "denied") setMicNote(null); // the session's own note says it
      else if (r.code !== "already_running") setMicNote("Couldn't start listening.");
    }
  }, [voiceAllowed, session, voiceSession]);

  const stopSpeaking = useCallback(() => ttsRef.current.stop(), []);

  /* The waveform reflects what is actually happening, in the order
     that matters to the user. Nothing here animates on a timer or
     invents activity: every branch is a real, observable condition. */
  const displayState =
    mode === CIRRUS_MODES.OFF
      ? WAVEFORM_STATES.PAUSED
      : session.state === SESSION_STATES.SPEAKING || tts.speaking
      ? WAVEFORM_STATES.SPEAKING
      : session.state === SESSION_STATES.THINKING
      ? WAVEFORM_STATES.THINKING
      : mic.listening
      ? WAVEFORM_STATES.LISTENING
      : tts.speaking
      ? WAVEFORM_STATES.SPEAKING
      : conversation.sending
      ? WAVEFORM_STATES.THINKING
      : pending
      ? WAVEFORM_STATES.APPROVAL
      : WAVEFORM_STATES.READY;

  const statusLabel = mode === CIRRUS_MODES.OFF ? "off" : displayState;

  return (
    <>
      <button
        type="button"
        className={
          mode === CIRRUS_MODES.OFF ? "cirrus-toggle off" : open ? "cirrus-toggle on" : "cirrus-toggle"
        }
        onClick={() => setOpen((v) => !v)}
        title="Cirrus (⌘J / Ctrl+J)"
        aria-label={`Cirrus — ${MODE_LABEL[mode]}${open ? ", open" : ""}`}
        aria-expanded={open}
      >
        {mode === CIRRUS_MODES.OFF ? (
          <span className="cirrus-dot" aria-hidden="true" />
        ) : (
          <Waveform state={displayState} size={14} />
        )}
      </button>

      {open && (
        <>
          <div className="cirrus-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={panelRef}
            className={collapsed ? "cirrus-panel collapsed" : "cirrus-panel"}
            role="dialog"
            aria-label="Cirrus"
          >
            <div className="cirrus-panel-head">
              <Waveform state={displayState} size={18} />
              <div className="cirrus-head-text">
                <span className="cirrus-title">Cirrus</span>
                <span className="cirrus-status">
                  {MODE_LABEL[mode]} &middot; {statusLabel}
                </span>
              </div>
              <button
                type="button"
                className="cirrus-icon-btn"
                onClick={() => setCollapsed((v) => !v)}
                title={collapsed ? "Expand" : "Collapse"}
                aria-label={collapsed ? "Expand Cirrus panel" : "Collapse Cirrus panel"}
              >
                {collapsed ? "▾" : "▴"}
              </button>
              <button
                type="button"
                className="cirrus-icon-btn"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close Cirrus"
              >
                ✕
              </button>
            </div>

            {!collapsed && (
              <div className="cirrus-body">
                <div className="cirrus-modes" role="radiogroup" aria-label="Cirrus mode">
                  {MODE_ORDER.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      className={mode === m ? "cirrus-mode on" : "cirrus-mode"}
                      onClick={() => setMode(m)}
                    >
                      {MODE_LABEL[m]}
                    </button>
                  ))}
                </div>

                {mode === CIRRUS_MODES.OFF ? (
                  <p className="cirrus-note">
                    Off. No model calls, no microphone, no proactive activity.
                  </p>
                ) : (
                  <>
                    <div className="cirrus-chat-log">
                      {conversation.messages.length === 0 && !conversation.error && (
                        <p className="cirrus-note">
                          This conversation stays on this device and isn't saved.
                        </p>
                      )}
                      {conversation.messages.length > 0 && (
                        <div className="cirrus-log-list">
                          {conversation.messages.map((m) => (
                            <p key={m.id} className={`cirrus-log-msg ${m.role}`}>
                              {m.content}
                            </p>
                          ))}
                        </div>
                      )}
                      {conversation.sending && (
                        <p className="cirrus-note" aria-live="polite">
                          Thinking…
                        </p>
                      )}
                      {conversation.error && (
                        <div className="cirrus-error" role="status">
                          <p className="cirrus-error-msg">{conversation.error.message}</p>
                          {/* The specific cause, when the backend gave one.
                              Shown inline because there is no console to
                              check on a tablet or phone. */}
                          {conversation.error.detail && (
                            <p className="cirrus-error-detail">
                              {conversation.error.code}: {conversation.error.detail}
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {session.running && (
                      <div className="cirrus-session-row" aria-live="polite">
                        <span className={`cirrus-session-dot ${session.state}`} aria-hidden="true" />
                        <span className="cirrus-note">
                          {session.state === SESSION_STATES.SPEAKING
                            ? "Cirrus is speaking…"
                            : session.state === SESSION_STATES.THINKING
                            ? "Thinking…"
                            : mic.interim
                            ? mic.interim
                            : "Listening — just talk."}
                        </span>
                        <button type="button" className="cirrus-chip live" onClick={() => session.end()}>
                          End session
                        </button>
                      </div>
                    )}
                    {!session.running && mic.listening && (
                      <p className="cirrus-note listening" aria-live="polite">
                        Listening… {mic.interim ? <em>{mic.interim}</em> : "speak now"}
                      </p>
                    )}
                    {session.note && <p className="cirrus-note dim">{session.note}</p>}
                    {tts.speaking && !session.running && (
                      <div className="cirrus-speaking-row" aria-live="polite">
                        <span className="cirrus-note dim">Speaking…</span>
                        <button type="button" className="cirrus-chip live" onClick={stopSpeaking}>
                          Stop
                        </button>
                      </div>
                    )}
                    {micNote && <p className="cirrus-note dim">{micNote}</p>}
                    {mic.error && (
                      <div className="cirrus-error" role="status">
                        <p className="cirrus-error-msg">{mic.error.message}</p>
                        {mic.state === SPEECH_STATES.DENIED && (
                          <p className="cirrus-error-detail">
                            Typing still works. Cirrus won't ask again this session.
                          </p>
                        )}
                      </div>
                    )}
                    {tts.error && (
                      <div className="cirrus-error" role="status">
                        <p className="cirrus-error-msg">{tts.error.message}</p>
                        {/* The actual cause, shown inline because there
                            is no console to open on a tablet. */}
                        {tts.error.detail && (
                          <p className="cirrus-error-detail">
                            {tts.error.code}: {tts.error.detail}
                          </p>
                        )}
                        <p className="cirrus-error-detail">The reply above is unaffected.</p>
                        {/* Offered only for failures the server can
                            explain. A blocked autoplay or a superseded
                            turn is a browser-side fact we already know,
                            and asking the function about it would tell
                            the user nothing. */}
                        {!CLIENT_SIDE_TTS_CODES.has(tts.error.code) && (
                        <button
                          type="button"
                          className="cirrus-chip live"
                          onClick={async () => {
                            setVoiceReport("Checking…");
                            const r = await diagnoseVoice();
                            setVoiceReport(
                              r.ok
                                ? r.report?.problem ||
                                  `Configuration looks correct. Models available: ${(r.report?.availableTextToSpeechModels || []).join(", ") || "none reported"}.`
                                : `${r.code}: ${r.detail || "no detail"}`
                            );
                          }}
                        >
                          Why?
                        </button>
                        )}
                        {voiceReport && <p className="cirrus-error-detail">{voiceReport}</p>}
                      </div>
                    )}

                    <ApprovalCard
                      pending={pending}
                      data={data}
                      onApprove={() => resolveApproval({ decision: "approve" })}
                      onCancel={() => {
                        approvalRef.current.cancel();
                        syncPending();
                        conversation.addMessage("assistant", "Cancelled. Nothing was changed.");
                      }}
                    />

                    <div className="cirrus-suggestions" aria-label="Suggestions">
                      {["Today's mission", "What's due", "Weekly pace"].map((s) => (
                        <button key={s} type="button" className="cirrus-chip" disabled>
                          {s}
                        </button>
                      ))}
                    </div>

                    <form className="cirrus-chat-input" onSubmit={sendDraft}>
                      <input
                        type="text"
                        placeholder={conversation.sending ? "Waiting for Cirrus…" : "Talk to Cirrus…"}
                        aria-label="Message Cirrus"
                        value={draft}
                        disabled={conversation.sending}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      {voiceAllowed && mic.supported && (
                        <button
                          type="button"
                          className={session.running ? "cirrus-mic on" : "cirrus-mic"}
                          onClick={toggleMic}
                          aria-pressed={session.running}
                          aria-label={session.running ? "End the voice session" : "Start a voice conversation"}
                          title={session.running ? "End the voice session" : "Start a voice conversation"}
                        >
                          {session.running ? "■" : "🎙"}
                        </button>
                      )}
                      <button
                        type="submit"
                        className="btn"
                        disabled={!draft.trim() || conversation.sending}
                      >
                        Send
                      </button>
                    </form>

                    {mode === CIRRUS_MODES.COMPANION && !mic.supported && (
                      <p className="cirrus-note dim">
                        This browser can't transcribe speech. Typing still works.
                      </p>
                    )}
                    {mode === CIRRUS_MODES.COMPANION && mic.supported && !session.running && !voiceSession && (
                      <p className="cirrus-note dim">
                        Tap the microphone once to start talking — Cirrus keeps listening
                        between replies. Your device transcribes the audio; FlightPlan never
                        records or stores it.
                      </p>
                    )}
                    {mode === CIRRUS_MODES.QUIET && (
                      <p className="cirrus-note dim">
                        Quiet is typed only. Switch to Companion for voice.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

/* ============================================================
   HOME STRIP
   Reflects Cirrus's own mode/status only — no fabricated insights.
   ============================================================ */
export function CirrusHomeStrip({ data, openPanel }) {
  const mode = data?.cirrus?.mode || CIRRUS_MODES.OFF;

  if (mode === CIRRUS_MODES.OFF) {
    return (
      <button type="button" className="cirrus-strip off" onClick={openPanel}>
        <span className="cirrus-dot" aria-hidden="true" />
        <span>Cirrus is off</span>
      </button>
    );
  }

  return (
    <button type="button" className="cirrus-strip" onClick={openPanel}>
      <Waveform state={WAVEFORM_STATES.READY} size={14} />
      <span>
        Cirrus &middot; {MODE_LABEL[mode]} &middot; ready
      </span>
      <span className="cirrus-strip-hint">⌘J</span>
    </button>
  );
}

export const CIRRUS_CSS = `
/* ---------- voice controls (Stage 7) ---------- */
.cirrus-mic{
  flex:0 0 auto; width:36px; height:36px; border-radius:9px;
  border:1px solid rgba(255,255,255,.18); background:transparent;
  color:inherit; font-size:15px; line-height:1; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center;
}
.cirrus-mic:hover:not(:disabled){ background:rgba(255,255,255,.07); }
.cirrus-mic:disabled{ opacity:.4; cursor:default; }
.cirrus-mic.on{
  background:rgba(255,120,100,.18); border-color:rgba(255,140,120,.55);
  animation:cirrusMicPulse 1.3s ease-in-out infinite;
}
@keyframes cirrusMicPulse{
  0%,100%{ box-shadow:0 0 0 0 rgba(255,140,120,.34); }
  50%{ box-shadow:0 0 0 5px rgba(255,140,120,0); }
}
.cirrus-note.listening em{ font-style:normal; opacity:.85; }
.cirrus-speaking-row{
  display:flex; align-items:center; justify-content:space-between;
  gap:8px; margin:2px 0 4px;
}
.cirrus-chip.live{
  cursor:pointer; opacity:1;
  border-color:rgba(255,255,255,.26); background:rgba(255,255,255,.05);
}
.cirrus-chip.live:hover{ background:rgba(255,255,255,.1); }
@media (prefers-reduced-motion: reduce){
  .cirrus-mic.on{ animation:none; }
}

/* ---------- continuous session (Stage 8) ---------- */
.cirrus-session-row{
  display:flex; align-items:center; gap:8px;
  margin:6px 0 4px; padding:6px 8px;
  border:1px solid rgba(255,255,255,.14); border-radius:9px;
  background:rgba(120,170,255,.06);
}
.cirrus-session-row .cirrus-note{ flex:1; margin:0; }
.cirrus-session-dot{
  width:7px; height:7px; border-radius:50%; flex:0 0 auto;
  background:var(--muted);
}
.cirrus-session-dot.listening{ background:var(--lamp); animation:cirrusSessionPulse 1.4s ease-in-out infinite; }
.cirrus-session-dot.thinking{ background:var(--green-bright); animation:cirrusSessionPulse .7s ease-in-out infinite; }
.cirrus-session-dot.speaking{ background:var(--bone); animation:cirrusSessionPulse .5s ease-in-out infinite; }
@keyframes cirrusSessionPulse{
  0%,100%{ opacity:1; transform:scale(1); }
  50%{ opacity:.45; transform:scale(.8); }
}
@media (prefers-reduced-motion: reduce){
  .cirrus-session-dot{ animation:none !important; }
}

/* ---------- approval card (Stage 6) ---------- */
.cirrus-approval{
  border:1px solid rgba(255,255,255,.16);
  border-radius:10px;
  padding:10px 12px;
  margin:8px 0 4px;
  background:rgba(120,170,255,.07);
}
.cirrus-approval.danger{
  border-color:rgba(255,140,120,.42);
  background:rgba(255,120,100,.09);
}
.cirrus-approval-head{
  display:flex; align-items:center; justify-content:space-between;
  gap:8px; margin-bottom:6px;
}
.cirrus-approval-tag{
  font-size:10px; letter-spacing:.09em; text-transform:uppercase;
  opacity:.72; font-weight:600;
}
.cirrus-approval-clock{ font-size:11px; opacity:.6; font-variant-numeric:tabular-nums; }
.cirrus-approval-action{ margin:0 0 6px; font-size:13px; line-height:1.35; }
.cirrus-approval-changes{ list-style:none; margin:0 0 6px; padding:0; font-size:12px; }
.cirrus-approval-changes li{
  display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; padding:2px 0;
}
.cirrus-field{ opacity:.6; min-width:58px; }
.cirrus-was{ opacity:.7; text-decoration:line-through; }
.cirrus-will{ font-weight:600; }
.cirrus-approval-effect,
.cirrus-approval-caution{ margin:0 0 6px; font-size:11.5px; opacity:.78; line-height:1.35; }
.cirrus-approval-caution{ opacity:.9; }
.cirrus-approval-actions{ display:flex; gap:8px; margin:8px 0 4px; }
.cirrus-approve,.cirrus-cancel{
  flex:1; padding:7px 10px; border-radius:8px; font-size:12.5px;
  font-weight:600; cursor:pointer; border:1px solid transparent;
}
.cirrus-approve{ background:rgba(120,170,255,.22); border-color:rgba(120,170,255,.5); color:inherit; }
.cirrus-approval.danger .cirrus-approve{
  background:rgba(255,120,100,.2); border-color:rgba(255,140,120,.55);
}
.cirrus-cancel{ background:transparent; border-color:rgba(255,255,255,.2); color:inherit; }
.cirrus-approve:hover{ filter:brightness(1.15); }
.cirrus-cancel:hover{ background:rgba(255,255,255,.06); }

  .cirrus-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px;
    border-radius: 10px;
    border: 1px solid var(--edge);
    background: rgba(127,178,212,.06);
    cursor: pointer;
    transition: border-color .15s ease, background .15s ease;
  }
  .cirrus-toggle:hover { border-color: var(--lamp); background: rgba(127,178,212,.12); }
  .cirrus-toggle.on { border-color: var(--green-bright); background: rgba(62,142,99,.14); }
  .cirrus-toggle.off {
    border-color: transparent;
    background: none;
    width: 20px; height: 20px;
    opacity: .45;
  }
  .cirrus-toggle.off:hover { opacity: .8; }
  .cirrus-dot {
    display: block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--faint);
  }

  /* scrim: inert on desktop (non-modal side panel), dismissible on mobile */
  .cirrus-scrim {
    position: fixed; inset: 0; z-index: 45;
    background: transparent; pointer-events: none;
  }

  .cirrus-panel {
    position: fixed; top: 62px; right: 0; bottom: 0;
    width: min(400px, 92vw);
    z-index: 46;
    display: flex; flex-direction: column;
    background: var(--raised);
    border-left: 1px solid var(--line);
    box-shadow: -12px 0 32px rgba(0,0,0,.35);
    animation: cirrusSlideIn .22s cubic-bezier(.22,.61,.36,1) both;
  }
  .cirrus-panel.collapsed { bottom: auto; box-shadow: -12px 12px 32px rgba(0,0,0,.3); }
  @keyframes cirrusSlideIn {
    from { transform: translateX(24px); opacity: 0; }
    to { transform: none; opacity: 1; }
  }

  .cirrus-panel-head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 12px 14px 16px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .cirrus-head-text { display: flex; flex-direction: column; margin-right: auto; min-width: 0; }
  .cirrus-title { font-weight: 600; color: var(--bone); font-size: 14px; }
  .cirrus-status { font-size: 11px; color: var(--faint); text-transform: capitalize; }

  .cirrus-icon-btn {
    flex: none; width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    border: none; background: none; color: var(--muted);
    border-radius: 7px; cursor: pointer; font-size: 12px;
    transition: color .15s ease, background .15s ease;
  }
  .cirrus-icon-btn:hover { color: var(--bone); background: rgba(255,255,255,.06); }

  .cirrus-body {
    flex: 1; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column; gap: 12px;
    padding: 14px 16px 16px;
  }

  .cirrus-modes { display: flex; gap: 4px; padding: 3px; background: var(--surface); border-radius: 10px; flex: none; }
  .cirrus-mode {
    flex: 1; border: none; background: none; color: var(--muted);
    font-family: 'Inter', system-ui, sans-serif; font-size: 12.5px; font-weight: 500;
    padding: 6px 4px; border-radius: 8px; cursor: pointer;
    transition: color .15s ease, background .15s ease;
  }
  .cirrus-mode:hover { color: var(--bone); }
  .cirrus-mode.on { color: var(--green-bright); background: rgba(62,142,99,.16); }

  .cirrus-note { font-size: 12px; color: var(--faint); line-height: 1.5; margin: 0; }
  .cirrus-note.dim { opacity: .8; }

  .cirrus-chat-log { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  .cirrus-log-list { display: flex; flex-direction: column; gap: 6px; }
  .cirrus-log-msg {
    margin: 0; max-width: 88%;
    font-size: 13px; line-height: 1.45;
    padding: 8px 11px;
    white-space: pre-wrap; word-break: break-word;
  }
  .cirrus-log-msg.user {
    align-self: flex-end;
    background: rgba(62,142,99,.14); color: var(--bone);
    border-radius: 12px 12px 2px 12px;
  }
  .cirrus-log-msg.assistant {
    align-self: flex-start;
    background: var(--surface); color: var(--bone);
    border: 1px solid var(--line);
    border-radius: 12px 12px 12px 2px;
  }
  .cirrus-error {
    border-left: 2px solid var(--alert);
    padding-left: 9px;
  }
  .cirrus-error-msg {
    margin: 0; font-size: 12px; line-height: 1.5; color: var(--alert);
  }
  .cirrus-error-detail {
    margin: 3px 0 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10.5px; line-height: 1.45;
    color: var(--faint);
    word-break: break-word;
  }

  .cirrus-suggestions { display: flex; flex-wrap: wrap; gap: 6px; flex: none; }
  .cirrus-chip {
    border: 1px solid var(--edge); background: var(--surface); color: var(--muted);
    font-family: 'Inter', system-ui, sans-serif; font-size: 11.5px;
    padding: 6px 10px; border-radius: 999px; cursor: not-allowed;
  }

  .cirrus-chat-input { display: flex; gap: 6px; flex: none; }
  .cirrus-chat-input input {
    flex: 1; min-width: 0; padding: 8px 10px; font-size: 13px; border-radius: 8px;
  }
  .cirrus-chat-input .btn { padding: 8px 14px; font-size: 13px; }

  /* Home strip */
  .cirrus-strip {
    display: flex; align-items: center; gap: 10px;
    width: 100%; text-align: left;
    padding: 10px 14px;
    margin-bottom: 22px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(62,142,99,.05);
    color: var(--muted);
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    cursor: pointer;
    transition: border-color .15s ease, background .15s ease;
  }
  .cirrus-strip:hover { border-color: var(--edge); background: rgba(62,142,99,.09); }
  .cirrus-strip.off { color: var(--faint); background: transparent; }
  .cirrus-strip-hint {
    margin-left: auto; font-family: 'JetBrains Mono', monospace; font-size: 10px;
    color: var(--faint); letter-spacing: .05em;
  }

  /* waveform */
  .cirrus-bar { fill: var(--muted); transform-origin: 30px 12px; }

  .cirrus-wave-ready .cirrus-bar { fill: var(--muted); animation: cirrusBreathe 2.6s ease-in-out infinite; }
  @keyframes cirrusBreathe {
    0%, 100% { opacity: .5; transform: scaleY(1); }
    50% { opacity: .9; transform: scaleY(1.35); }
  }

  .cirrus-wave-listening .cirrus-bar { fill: var(--lamp); animation: cirrusPulse .85s ease-in-out infinite; }
  .cirrus-wave-thinking .cirrus-bar { fill: var(--green-bright); animation: cirrusPulse .55s ease-in-out infinite; }
  .cirrus-wave-speaking .cirrus-bar { fill: var(--bone); animation: cirrusPulse .4s ease-in-out infinite; }
  @keyframes cirrusPulse {
    0%, 100% { transform: scaleY(.6); }
    50% { transform: scaleY(2.1); }
  }

  .cirrus-wave-approval .cirrus-bar { fill: var(--alert); animation: cirrusBreathe 1.1s ease-in-out infinite; }
  .cirrus-wave-paused .cirrus-bar { fill: var(--faint); animation: none; opacity: .4; transform: scaleY(.6); }

  @media (prefers-reduced-motion: reduce) {
    .cirrus-panel { animation: none; }
    .cirrus-bar { animation: none !important; }
  }

  @media (max-width: 720px) {
    .cirrus-scrim { background: rgba(0,0,0,.45); pointer-events: auto; }
    .cirrus-panel {
      left: 0; right: 0; top: auto; bottom: 0;
      width: 100%; height: 86vh;
      border-left: none; border-top: 1px solid var(--line);
      border-radius: 16px 16px 0 0;
      animation: cirrusSlideUp .22s cubic-bezier(.22,.61,.36,1) both;
    }
    .cirrus-panel.collapsed { height: auto; }
    @keyframes cirrusSlideUp {
      from { transform: translateY(24px); opacity: 0; }
      to { transform: none; opacity: 1; }
    }
  }
`;
