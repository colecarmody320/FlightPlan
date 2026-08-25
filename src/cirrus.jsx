import React, { useRef, useState, useEffect } from "react";
import { CIRRUS_MODES, WAVEFORM_STATES } from "./cirrusShared.js";
import { useCirrusConversation } from "./cirrusConversation.js";

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
export function CirrusDock({ data, update, open, setOpen, page, selectedObject }) {
  const mode = data?.cirrus?.mode || CIRRUS_MODES.OFF;
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState("");
  const panelRef = useRef(null);
  const conversation = useCirrusConversation({ mode, page, selectedObject });

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

  const setMode = (m) =>
    update((d) => ({ ...d, cirrus: { ...(d.cirrus || blankCirrus()), mode: m } }));

  const sendDraft = (e) => {
    e.preventDefault();
    if (!draft.trim() || conversation.sending) return;
    conversation.send(draft);
    setDraft("");
  };

  const statusLabel = mode === CIRRUS_MODES.OFF ? "off" : conversation.voiceState;

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
          <Waveform state={conversation.voiceState} size={14} />
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
              <Waveform state={conversation.voiceState} size={18} />
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
                      <button
                        type="submit"
                        className="btn"
                        disabled={!draft.trim() || conversation.sending}
                      >
                        Send
                      </button>
                    </form>

                    {mode === CIRRUS_MODES.COMPANION && (
                      <p className="cirrus-note dim">
                        Voice starts from a deliberate action here — not yet wired.
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
