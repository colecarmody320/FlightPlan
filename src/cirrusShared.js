/* ============================================================
   CIRRUS — shared constants
   Split out so cirrus.jsx (UI) and cirrusConversation.js (state)
   can both reference the same values without importing each other.
   ============================================================ */

export const CIRRUS_MODES = {
  OFF: "off",
  QUIET: "quiet",
  COMPANION: "companion",
};

export const WAVEFORM_STATES = {
  READY: "ready",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  APPROVAL: "approval",
  PAUSED: "paused",
};
