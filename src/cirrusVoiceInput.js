import { useMemo } from "react";
import { useVoiceInput, speechSupport } from "./cirrusSpeech.js";
import { useVoiceRecorder, recorderSupport, isIOS } from "./cirrusRecorder.js";

/* ============================================================
   CIRRUS — CHOOSING A CAPTURE ENGINE (Stage 9)

   Two engines, one contract. The session controller drives whichever
   it is handed without knowing which it has.

     RECOGNITION  webkitSpeechRecognition. No audio leaves the device
                  for us to handle, no per-utterance cost, no network
                  round trip. Kept wherever it is dependable.

     RECORDER     getUserMedia + MediaRecorder + our own transcription
                  function. Costs a round trip and sends audio off the
                  device, but its lifecycle is ours.

   WHY iOS GETS THE RECORDER. Safari's recognizer cannot hold a
   continuous conversation. It ends when another element takes the audio
   session — which Cirrus's playback does every turn — and afterwards
   refuses to restart without a fresh tap. Stage 8 chased that through
   several honest fixes; the last one made the failure visible rather
   than silent, which is as far as a fix can go when the lifecycle
   belongs to the browser. A MediaRecorder has no such behaviour: it
   stops when we stop it.

   Everywhere else recognition still wins on latency, cost and privacy,
   so it stays the default. This is progressive enhancement in the
   direction that actually helps — the weaker platform gets the heavier
   machinery, not the other way round.
   ============================================================ */

export const ENGINES = {
  RECOGNITION: "recognition",
  RECORDER: "recorder",
  NONE: "none",
};

/**
 * Decides once, at mount.
 *
 * Exported so a test can pin the decision without a browser, and so the
 * UI can explain which engine is running when voice is unavailable.
 */
export function pickEngine({ ios, recognition, recorder } = {}) {
  const onIOS = ios ?? isIOS();
  const canRecognise = recognition ?? speechSupport().available;
  const canRecord = recorder ?? recorderSupport().available;

  // iOS first: recognition may report itself available there and still
  // fail on the second turn, so availability is not the question.
  if (onIOS && canRecord) return ENGINES.RECORDER;
  if (canRecognise) return ENGINES.RECOGNITION;
  if (canRecord) return ENGINES.RECORDER;
  return ENGINES.NONE;
}

/**
 * Runs the chosen engine and returns it under the shared contract.
 *
 * BOTH hooks are called every render — hooks cannot be conditional —
 * but only the chosen one is ever enabled. The other sees `enabled:
 * false` for its whole life, which is exactly the state in which each
 * releases its hardware and refuses to start. There is never a moment
 * when two engines could hold the microphone.
 */
export function useCirrusVoiceInput({ enabled = false, onTranscript, onEnd } = {}) {
  const engine = useMemo(() => pickEngine(), []);

  const recognition = useVoiceInput({
    enabled: enabled && engine === ENGINES.RECOGNITION,
    onTranscript,
    onEnd,
  });

  const recorder = useVoiceRecorder({
    enabled: enabled && engine === ENGINES.RECORDER,
    onTranscript,
    onEnd,
  });

  const active = engine === ENGINES.RECORDER ? recorder : recognition;

  return {
    ...active,
    engine,
    // Recognition has no transcription step; saying so explicitly keeps
    // the session's state machine from having to know the difference.
    transcribing: Boolean(active.transcribing),
    supported: engine !== ENGINES.NONE && active.supported,
    /* Whether the spoken words are transcribed on this device or by our
       server. The dock says which before first use — the honest
       disclosure differs between the two, and the user is entitled to
       know which one is running. */
    onDevice: engine === ENGINES.RECOGNITION,
  };
}
