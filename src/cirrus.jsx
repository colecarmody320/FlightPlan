import React, { useState, useRef, useEffect } from "react";

/* ============================================================
   CIRRUS — personal assistant layer
   Self-contained, like aviation.jsx. Inherits the .hub palette and
   cabin lighting via CSS variables. This module is scaffolding only:
   mode state + the waveform indicator + the dock UI. No provider
   calls (Gemini/ElevenLabs/Calendar) are wired in yet — those land
   in later phases behind the allowlisted-action/permission gate
   described in the project brief. FlightPlan must work identically
   with this module removed entirely; nothing here touches app data
   outside the `cirrus` key.
   ============================================================ */

export const CIRRUS_MODES = {
  OFF: "off",
  QUIET: "quiet",
  COMPANION: "companion",
};

const MODE_ORDER = [CIRRUS_MODES.OFF, CIRRUS_MODES.QUIET, CIRRUS_MODES.COMPANION];
const MODE_LABEL = {
  [CIRRUS_MODES.OFF]: "Off",
  [CIRRUS_MODES.QUIET]: "Quiet",
  [CIRRUS_MODES.COMPANION]: "Companion",
};

export const WAVEFORM_STATES = {
  READY: "ready",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  APPROVAL: "approval",
  PAUSED: "paused",
};

/* ---------- persisted state ---------- */
export function blankCirrus() {
  return { mode: CIRRUS_MODES.OFF };
}

// Additive only — an older or partial `data.cirrus` (or none at all)
// still resolves to a valid, safe-default state.
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
   DOCK
   Header control. OFF renders a single faint icon button and
   nothing else — "nearly invisible." Any other mode adds the
   waveform + an expandable panel with the mode switch and a
   conversation shell (not yet wired to a provider).
   ============================================================ */
export function CirrusDock({ data, update }) {
  const mode = data?.cirrus?.mode || CIRRUS_MODES.OFF;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const setMode = (m) =>
    update((d) => ({ ...d, cirrus: { ...(d.cirrus || blankCirrus()), mode: m } }));

  return (
    <div className="cirrus-dock" ref={ref}>
      <button
        type="button"
        className={mode === CIRRUS_MODES.OFF ? "cirrus-toggle off" : "cirrus-toggle"}
        onClick={() => setOpen((v) => !v)}
        title="Cirrus"
        aria-label={`Cirrus — ${MODE_LABEL[mode]}`}
        aria-expanded={open}
      >
        {mode === CIRRUS_MODES.OFF ? (
          <span className="cirrus-dot" aria-hidden="true" />
        ) : (
          <Waveform state={WAVEFORM_STATES.READY} size={14} />
        )}
      </button>

      {open && (
        <div className="cirrus-panel" role="dialog" aria-label="Cirrus settings">
          <div className="cirrus-panel-head">
            <Waveform state={WAVEFORM_STATES.READY} size={18} />
            <span className="cirrus-title">Cirrus</span>
          </div>

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

          {mode === CIRRUS_MODES.OFF && (
            <p className="cirrus-note">
              Off. No model calls, no microphone, no proactive activity.
            </p>
          )}

          {mode !== CIRRUS_MODES.OFF && (
            <div className="cirrus-chat">
              <div className="cirrus-chat-log">
                <p className="cirrus-note">
                  Not connected to a reasoning provider yet — this is the interface
                  shell for {MODE_LABEL[mode].toLowerCase()} mode.
                </p>
              </div>
              <div className="cirrus-chat-input">
                <input
                  type="text"
                  placeholder="Talk to Cirrus…"
                  disabled
                  aria-label="Message Cirrus"
                />
                <button type="button" className="btn" disabled>
                  Send
                </button>
              </div>
              {mode === CIRRUS_MODES.COMPANION && (
                <p className="cirrus-note dim">Voice starts from a deliberate action here — not yet wired.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const CIRRUS_CSS = `
  .cirrus-dock { position: relative; flex: none; }

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

  .cirrus-panel {
    position: absolute; right: 0; top: calc(100% + 8px);
    width: 280px; z-index: 20;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 14px;
    box-shadow: 0 12px 32px rgba(0,0,0,.35);
  }
  .cirrus-panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .cirrus-title { font-weight: 600; color: var(--bone); font-size: 14px; }

  .cirrus-modes { display: flex; gap: 4px; padding: 3px; background: var(--surface); border-radius: 10px; margin-bottom: 10px; }
  .cirrus-mode {
    flex: 1; border: none; background: none; color: var(--muted);
    font-family: 'Inter', system-ui, sans-serif; font-size: 12.5px; font-weight: 500;
    padding: 6px 4px; border-radius: 8px; cursor: pointer;
    transition: color .15s ease, background .15s ease;
  }
  .cirrus-mode:hover { color: var(--bone); }
  .cirrus-mode.on { color: var(--green-bright); background: rgba(62,142,99,.16); }

  .cirrus-note { font-size: 12px; color: var(--faint); line-height: 1.5; margin: 0; }
  .cirrus-note.dim { margin-top: 8px; opacity: .8; }

  .cirrus-chat-log { margin-bottom: 10px; }
  .cirrus-chat-input { display: flex; gap: 6px; }
  .cirrus-chat-input input {
    flex: 1; min-width: 0; padding: 8px 10px; font-size: 13px; border-radius: 8px;
  }
  .cirrus-chat-input .btn { padding: 8px 14px; font-size: 13px; }

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
`;
