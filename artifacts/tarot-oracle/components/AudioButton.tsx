import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  getTtsUsage,
  getTtsPrepStatus,
  isTtsCached,
  speakText,
  stopTts,
  subscribeTtsPrep,
  subscribeTtsPlayback,
  subscribeTtsUsage,
  type TtsStatus,
  type TtsUsageSnapshot,
} from '@/lib/tts';

function withAlpha(hex: string, alpha: number): string {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface AudioButtonProps {
  text: string;
  accent?: string;
  /** Optional label shown next to the icon. */
  label?: string;
  /** Pill-compact mode (no label, smaller). */
  compact?: boolean;
  /** Notifies visual companions such as the speaking oracle about TTS state. */
  onPlaybackStateChange?: (status: TtsStatus) => void;
  /** Starts TTS once when a freshly generated reading becomes available. */
  autoPlay?: boolean;
  /** Optional settling delay before automatic playback starts. */
  autoPlayDelayMs?: number;
}

export function AudioButton({
  text,
  accent = '#F5E3A8',
  label,
  compact = false,
  onPlaybackStateChange,
  autoPlay = false,
  autoPlayDelayMs = 80,
}: AudioButtonProps) {
  const [status, setStatus] = useState<TtsStatus>('idle');
  const [, setUsage] = useState<TtsUsageSnapshot>(getTtsUsage());
  const [, forcePrep] = useState(0);
  const inFlight = useRef(false);
  const pulse = useSharedValue(1);
  const autoPlayedText = useRef<string | null>(null);

  useEffect(() => subscribeTtsUsage(setUsage), []);

  useEffect(
    () =>
      subscribeTtsPlayback(({ active }) => {
        if (!active) {
          setStatus((previous) =>
            previous === 'playing' || previous === 'speaking' ? 'idle' : previous,
          );
        }
      }),
    [],
  );

  // Observe preparation state only. TTS generation must never start merely
  // because a section became visible: every request consumes Gemini quota.
  useEffect(() => {
    onPlaybackStateChange?.(status);
  }, [onPlaybackStateChange, status]);

  useEffect(() => {
    const t = text.trim();
    if (!t) return;
    const unsubscribePrep = subscribeTtsPrep(() => forcePrep((n) => n + 1));
    return () => {
      unsubscribePrep();
    };
  }, [text]);

  useEffect(() => {
    if (status === 'loading' || status === 'playing' || status === 'speaking') {
      pulse.value = withRepeat(
        withTiming(1.2, { duration: 650, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      pulse.value = withTiming(1, { duration: 200 });
    }
  }, [status, pulse]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  const handlePress = async () => {
    if (inFlight.current) return;
    Haptics.selectionAsync().catch(() => {});
    if (status === 'playing' || status === 'speaking') {
      await stopTts();
      setStatus('idle');
      return;
    }
    inFlight.current = true;
    setStatus('loading');
    try {
      const result = await speakText(text);
      setStatus(result.source === 'gemini' ? 'playing' : 'speaking');
      // Estimated end so the icon returns to idle even if the player doesn't
      // emit a "finished" event under unusual error paths.
      const approxMs = Math.max(45000, text.length * 65);
      setTimeout(() => {
        setStatus((prev) => (prev === 'loading' ? 'idle' : prev));
      }, approxMs);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 1500);
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    const trimmed = text.trim();
    if (!autoPlay || !trimmed || autoPlayedText.current === trimmed) return;
    autoPlayedText.current = trimmed;
    const timer = setTimeout(() => {
      void handlePress();
    }, autoPlayDelayMs);
    return () => clearTimeout(timer);
  }, [autoPlay, autoPlayDelayMs, text]);

  const isLoading = status === 'loading';
  const isActive = status === 'playing' || status === 'speaking';
  const prepStatus = getTtsPrepStatus(text);
  const audioReady = isTtsCached(text) || prepStatus === 'ready';
  // "stagedReady" combines the active playback state with the cache-warm
  // state — used as a single switch for icon + opacity. When the cache is
  // cold we deliberately show a non-speaker icon and dim the button so the
  // user can see "not ready yet" before pressing (and trust the next tap
   // will actually stream the selected Gemini studio voice.
  // The button remains actionable while TTS is warming. A greyed-out HP
  // suggested that playback was unavailable, although the server request
  // was still in flight for long readings.
  const stagedReady = true;
  const iconName = isActive
    ? 'pause-circle'
    : stagedReady
      ? 'volume-2'
      : 'cloud-lightning';
  const prepDotColor =
    audioReady
      ? withAlpha(accent, 0.9)
      : prepStatus === 'error'
        ? '#E88A70'
        : withAlpha(accent, 0.35);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        isActive ? 'Arrêter la lecture' : 'Lire la réponse à voix haute'
      }
      hitSlop={10}
      style={({ pressed }) => [
        styles.btn,
        compact && styles.btnCompact,
        {
          borderColor: withAlpha(accent, 0.55),
          backgroundColor: pressed
            ? withAlpha(accent, 0.18)
            : withAlpha(accent, 0.08),
          opacity: isLoading ? 0.7 : 1,
        },
      ]}
    >
      <Animated.View style={iconStyle}>
        <Feather
          name={isLoading ? 'volume-2' : iconName}
          size={compact ? 16 : 18}
          color={accent}
        />
      </Animated.View>
      {!isActive ? (
        <View
          style={[styles.prepDot, { backgroundColor: prepDotColor }]}
          accessibilityLabel={
            prepStatus === 'ready'
              ? 'Audio prêt'
              : prepStatus === 'error'
                ? 'Audio indisponible'
                : 'Audio disponible à la demande'
          }
        />
      ) : null}
      {label ? (
        <Text style={[styles.label, { color: accent }]}>
          {isActive
            ? status === 'speaking'
              ? 'Voix système…'
              : 'Lecture…'
            : label ?? (prepStatus === 'pending' ? 'Préparation…' : 'Écouter')}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  btnCompact: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  prepDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
