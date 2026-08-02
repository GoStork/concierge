// Shared level meter for Eva's REMOTE audio (the LiveKit avatar track).
//
// iOS Safari's echo cancellation does not reliably cancel WebRTC remote audio
// played through an <audio> element - the avatar's own voice leaks from the
// speaker back into the mic loudly enough (RMS ~0.2 measured) to trip the
// barge-in detector and cut Eva off mid-reply. The fix is echo-AWARE barging:
// AvatarVideo feeds the remote track into an analyser (owned by the voice
// audio engine so everything lives in the one gesture-resumed AudioContext),
// writes the current output level here, and the VAD only calls something a
// barge-in when the mic is clearly louder than the echo of that output could
// be.

export const remoteAudioLevel = { rms: 0, updatedAt: 0 };

type RemoteAnalyzer = (track: MediaStreamTrack) => () => void;

let analyzer: RemoteAnalyzer | null = null;

// The audio engine registers the real analyser at session start (it owns the
// AudioContext); AvatarVideo just hands tracks over.
export function registerRemoteAnalyzer(a: RemoteAnalyzer | null): void {
  analyzer = a;
}

// Returns a cleanup function; a no-op when no engine is active.
export function analyzeRemoteTrack(track: MediaStreamTrack): () => void {
  if (!analyzer) return () => {};
  try {
    return analyzer(track);
  } catch (err) {
    console.error("[voice] remote track analysis failed:", err);
    return () => {};
  }
}
