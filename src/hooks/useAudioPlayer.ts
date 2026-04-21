import { useCallback, useRef, useState } from "react";

/**
 * Single-instance audio player for the call list.
 *
 * Was previously inlined in page.tsx (~110 lines of useRef/useState/useCallback
 * spread across the 2k-line file). Extracted here because:
 *
 *   1. It's genuinely self-contained — no DOM lookups, no cross-cutting state.
 *   2. The shape (toggle one call at a time, swap src on play) is reused
 *      implicitly by several tabs; centralising keeps them in sync.
 *   3. Every state transition (play / pause / swap / seek / rate) has been
 *      preserved exactly; this is a pure refactor, not a behavior change.
 *
 * Consumers still need to wire the three `audio*` values into whatever UI
 * they render (progress bar, play/pause icon, etc).
 */

export interface AudioPlayerState {
  /** Id of the call currently playing (or loading). null when idle. */
  playingCallId: string | null;
  /** Id of the call currently loading — so callers can show a spinner. */
  audioLoading: string | null;
  audioCurrentTime: number;
  audioDuration: number;
  audioPlaybackRate: number;
  audioPaused: boolean;
}

export interface AudioPlayerAPI extends AudioPlayerState {
  /** Toggle play/pause for the given call. Swaps src if a different call plays. */
  toggleAudio: (call: { id: string; hasRecording: boolean; audioUrl: string }) => void;
  /** Stop playback, clear src, reset state. */
  stopAudio: () => void;
  /** Seek to a fraction (0..1) of the current track. */
  seekAudio: (fraction: number) => void;
  /** Cycle through 1× → 1.5× → 2× → 1×. */
  cyclePlaybackRate: () => void;
}

export function useAudioPlayer(): AudioPlayerAPI {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState<string | null>(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioPlaybackRate, setAudioPlaybackRate] = useState(1);
  const [audioPaused, setAudioPaused] = useState(false);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setPlayingCallId(null);
    setAudioLoading(null);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setAudioPaused(false);
  }, []);

  const toggleAudio = useCallback(
    (call: { id: string; hasRecording: boolean; audioUrl: string }) => {
      if (!call.hasRecording) return;

      // If same call is playing — toggle pause/resume
      if (playingCallId === call.id) {
        const audio = audioRef.current;
        if (audio) {
          if (audio.paused) {
            audio.play();
            setAudioPaused(false);
          } else {
            audio.pause();
            setAudioPaused(true);
          }
        }
        return;
      }

      // Stop previous audio
      stopAudio();

      // Start new audio
      setAudioLoading(call.id);
      setAudioPlaybackRate(1);
      const audio = new Audio();
      audio.preload = "auto";
      audioRef.current = audio;

      audio.onloadedmetadata = () => {
        setAudioDuration(audio.duration);
      };

      audio.ontimeupdate = () => {
        setAudioCurrentTime(audio.currentTime);
      };

      audio.oncanplay = () => {
        setAudioLoading(null);
        setPlayingCallId(call.id);
        setAudioPaused(false);
        audio.play().catch(() => {
          setPlayingCallId(null);
          setAudioLoading(null);
        });
      };

      audio.onended = () => {
        setPlayingCallId(null);
        setAudioCurrentTime(0);
        setAudioPaused(false);
      };

      audio.onerror = () => {
        console.error("Audio error:", audio.error?.message, audio.error?.code);
        setPlayingCallId(null);
        setAudioLoading(null);
      };

      // Set src after listeners to ensure events fire
      audio.src = call.audioUrl;
      audio.load();
    },
    [playingCallId, stopAudio],
  );

  const seekAudio = useCallback(
    (fraction: number) => {
      if (audioRef.current && audioDuration > 0) {
        audioRef.current.currentTime = fraction * audioDuration;
      }
    },
    [audioDuration],
  );

  const cyclePlaybackRate = useCallback(() => {
    const rates = [1, 1.5, 2];
    const nextIdx = (rates.indexOf(audioPlaybackRate) + 1) % rates.length;
    const newRate = rates[nextIdx];
    setAudioPlaybackRate(newRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = newRate;
    }
  }, [audioPlaybackRate]);

  return {
    playingCallId,
    audioLoading,
    audioCurrentTime,
    audioDuration,
    audioPlaybackRate,
    audioPaused,
    toggleAudio,
    stopAudio,
    seekAudio,
    cyclePlaybackRate,
  };
}
