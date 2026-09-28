import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { TtsStatus } from '@/lib/tts';
import { subscribeTtsPlayback } from '@/lib/tts';

const ORACLE_IMAGE = require('@/assets/images/oracle-kore.jpg');

function splitPrompterText(value: string): string[] {
  return value.match(/[^.!?…]+[.!?…]+(?:\s+|$)|.+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

function normalizePrompterText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function SpeakingOracle({
  status,
  text,
  preloadOnly = false,
  compact = false,
  onReady,
}: {
  status: TtsStatus;
  text: string;
  preloadOnly?: boolean;
  compact?: boolean;
  onReady?: () => void;
}) {
  const smoke = useRef(new Animated.Value(0.35)).current;
  const smokeDrift = useRef(new Animated.Value(0)).current;
  const smokeRise = useRef(new Animated.Value(0)).current;
  const prompterOffsetAnim = useRef(new Animated.Value(0)).current;
  const sentenceLayouts = useRef(new Map<number, number>()).current;
  const [textViewportHeight, setTextViewportHeight] = useState(0);
  const [textContentHeight, setTextContentHeight] = useState(0);
  const [activePhrase, setActivePhrase] = useState('');
  const [playbackDurationMs, setPlaybackDurationMs] = useState(0);
  const [playbackElapsedMs, setPlaybackElapsedMs] = useState(0);
  const [phraseElapsedMs, setPhraseElapsedMs] = useState(0);
  const [isPlaybackActive, setIsPlaybackActive] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [frameWidth, setFrameWidth] = useState(0);
  const playbackTextRef = useRef('');
  const playbackStartedAtRef = useRef<number | null>(null);
  const activePhraseStartedAtRef = useRef<number | null>(null);
  const lastActiveSentenceIndexRef = useRef(-1);
  const prompterAnimationKeyRef = useRef('');
  const readyNotified = useRef(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const prompterSentences = useMemo(() => splitPrompterText(text), [text]);
  const isFullReadingPlayback =
    isPlaybackActive && activePhrase.trim() === text.trim() && text.trim().length > 0;
  const activePhraseRange = useMemo(() => {
    if (isFullReadingPlayback || !activePhrase.trim()) return null;
    const normalizedPhrase = normalizePrompterText(activePhrase);
    const start = prompterSentences.findIndex((sentence) => {
      const normalizedSentence = normalizePrompterText(sentence);
      return (
        normalizedSentence.includes(normalizedPhrase) ||
        normalizedPhrase.includes(normalizedSentence)
      );
    });
    if (start < 0) return null;
    let end = start;
    for (let index = start + 1; index < prompterSentences.length; index += 1) {
      const normalizedSentence = normalizePrompterText(prompterSentences[index]);
      if (!normalizedPhrase.includes(normalizedSentence)) break;
      end = index;
    }
    return { start, end };
  }, [activePhrase, isFullReadingPlayback, prompterSentences]);
  const exactActiveIndex = useMemo(
    () =>
      isFullReadingPlayback
        ? -1
        : activePhraseRange?.start ??
          prompterSentences.findIndex(
            (sentence) =>
              sentence.trim() === activePhrase.trim() ||
              sentence.trim().startsWith(activePhrase.trim()) ||
              activePhrase.trim().startsWith(sentence.trim()),
          ),
    [activePhrase, activePhraseRange, isFullReadingPlayback, prompterSentences],
  );
  const estimatedReadingDurationMs = Math.max(
    4_000,
    text.length * 65,
    playbackDurationMs,
  );
  const calculatedActiveSentenceIndex =
    exactActiveIndex >= 0
      ? exactActiveIndex
      : isFullReadingPlayback && prompterSentences.length > 0
        ? Math.min(
            prompterSentences.length - 1,
            Math.floor(
              (playbackElapsedMs / estimatedReadingDurationMs) * prompterSentences.length,
            ),
          )
        : -1;
  const activeSentenceIndex =
    calculatedActiveSentenceIndex >= 0
      ? Math.max(lastActiveSentenceIndexRef.current, calculatedActiveSentenceIndex)
      : -1;
  const readingProgress =
    isFullReadingPlayback
      ? Math.min(1, playbackElapsedMs / estimatedReadingDurationMs)
      : activePhraseRange && prompterSentences.length > 0
        ? Math.min(
            1,
            (activePhraseRange.start +
              (activePhraseRange.end - activePhraseRange.start + 1) *
                Math.min(
                  0.98,
                  phraseElapsedMs / Math.max(1_000, playbackDurationMs),
                )) /
              prompterSentences.length,
          )
        : activeSentenceIndex >= 0 && prompterSentences.length > 0
        ? Math.min(
            1,
            (activeSentenceIndex +
              Math.min(
                0.98,
                phraseElapsedMs / Math.max(1_000, playbackDurationMs),
              )) /
              prompterSentences.length,
          )
        : 0;
  const frameHeight =
    frameWidth > 0
      ? frameWidth * (compact ? 1012 / 768 : 16 / 9)
      : undefined;

  useEffect(() => {
    sentenceLayouts.clear();
    setLayoutTick((tick) => tick + 1);
    if (!text.trim()) {
      setActivePhrase('');
      setPlaybackElapsedMs(0);
      setPhraseElapsedMs(0);
      setImageReady(false);
      readyNotified.current = false;
      playbackStartedAtRef.current = null;
      activePhraseStartedAtRef.current = null;
      prompterAnimationKeyRef.current = '';
      prompterOffsetAnim.setValue(0);
    }
  }, [prompterOffsetAnim, text]);

  useEffect(() => {
    if (!isPlaybackActive || activeSentenceIndex < 0 || !textViewportHeight || !textContentHeight) {
      return;
    }
    lastActiveSentenceIndexRef.current = Math.max(
      lastActiveSentenceIndexRef.current,
      activeSentenceIndex,
    );
    const maxScrollY = Math.max(0, textContentHeight - textViewportHeight);
    const lineHeight = compact ? 18 : 25;
    const activeY = sentenceLayouts.get(activeSentenceIndex) ?? activeSentenceIndex * lineHeight;
    const animationKey = isFullReadingPlayback
      ? `full:${text}`
      : `chunk:${text}:${activePhrase}:${playbackDurationMs}`;
    if (prompterAnimationKeyRef.current === animationKey) return;
    prompterAnimationKeyRef.current = animationKey;
    const chunkEndProgress =
      activePhraseRange && prompterSentences.length > 0
        ? (activePhraseRange.end + 1) / prompterSentences.length
        : readingProgress;
    const y = isFullReadingPlayback
      ? maxScrollY
      : maxScrollY > 0
        ? maxScrollY * chunkEndProgress
        : activeY - textViewportHeight * 0.22;
    // Animate to the end of the currently playing audio block. The TTS block
    // contains multiple prompter sentences, so scrolling by only one sentence
    // would drift behind the spoken words.
    Animated.timing(prompterOffsetAnim, {
      toValue: -Math.max(0, y),
      duration: isFullReadingPlayback
        ? estimatedReadingDurationMs
        : Math.max(520, playbackDurationMs),
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, [
    activeSentenceIndex,
    isPlaybackActive,
    textContentHeight,
    textViewportHeight,
    sentenceLayouts,
    compact,
    layoutTick,
    prompterOffsetAnim,
    estimatedReadingDurationMs,
    isFullReadingPlayback,
    activePhrase,
    activePhraseRange,
    playbackDurationMs,
    text,
  ]);

  useEffect(() => {
    if (!isPlaybackActive || (!isFullReadingPlayback && !activePhrase)) {
      return;
    }
    const timer = setInterval(() => {
      if (isFullReadingPlayback) {
        const startedAt = playbackStartedAtRef.current ?? Date.now();
        setPlaybackElapsedMs(Math.min(estimatedReadingDurationMs, Date.now() - startedAt));
      } else {
        const startedAt = activePhraseStartedAtRef.current ?? Date.now();
        setPhraseElapsedMs(Date.now() - startedAt);
      }
    }, 180);
    return () => {
      clearInterval(timer);
    };
  }, [
    activePhrase,
    estimatedReadingDurationMs,
    isFullReadingPlayback,
    isPlaybackActive,
  ]);

  useEffect(() => {
    if (!isPlaybackActive) {
      lastActiveSentenceIndexRef.current = -1;
      prompterAnimationKeyRef.current = '';
      // Stop at the current visual position. Do not reset the value: the
      // final phrase must remain visible when playback ends.
      prompterOffsetAnim.stopAnimation();
      // Keep the prompter at its last position when speech stops. Returning
      // to the beginning made the final phrase visibly jump away.
      setPlaybackElapsedMs(0);
      setPhraseElapsedMs(0);
    }
  }, [isPlaybackActive, prompterOffsetAnim]);

  useEffect(() => {
    if (!imageReady || preloadOnly || !text.trim() || readyNotified.current) return;
    readyNotified.current = true;
    onReady?.();
  }, [imageReady, onReady, preloadOnly, text]);

  useEffect(() => {
    return subscribeTtsPlayback(({ active, durationMs, text: activeText }) => {
      setIsPlaybackActive(active);
      if (active) {
        const nextText = activeText?.trim() || text.trim();
        if (nextText === text.trim() && playbackStartedAtRef.current === null) {
          playbackStartedAtRef.current = Date.now();
        }
        if (nextText && playbackTextRef.current !== nextText) {
          playbackTextRef.current = nextText;
          activePhraseStartedAtRef.current = Date.now();
          setPhraseElapsedMs(0);
          setPlaybackDurationMs(durationMs);
          setActivePhrase(nextText);
        }
        setPlaybackDurationMs(durationMs);
      } else if (!active) {
        lastActiveSentenceIndexRef.current = -1;
        playbackTextRef.current = '';
        playbackStartedAtRef.current = null;
        activePhraseStartedAtRef.current = null;
        setPlaybackDurationMs(0);
        setPhraseElapsedMs(0);
        setActivePhrase('');
      }
    });
  }, [text]);

  useEffect(() => {
    const smokeLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(smoke, { toValue: 0.8, duration: 1700, useNativeDriver: true }),
        Animated.timing(smoke, { toValue: 0.3, duration: 1700, useNativeDriver: true }),
      ]),
    );
    const smokeDriftLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(smokeDrift, { toValue: 1, duration: 1900, useNativeDriver: true }),
        Animated.timing(smokeDrift, { toValue: -1, duration: 2300, useNativeDriver: true }),
      ]),
    );
    const smokeRiseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(smokeRise, { toValue: 1, duration: 2200, useNativeDriver: true }),
        Animated.timing(smokeRise, { toValue: 0, duration: 2200, useNativeDriver: true }),
      ]),
    );
    smokeLoop.start();
    smokeDriftLoop.start();
    smokeRiseLoop.start();
    return () => {
      smokeLoop.stop();
      smokeDriftLoop.stop();
      smokeRiseLoop.stop();
    };
  }, [smoke, smokeDrift, smokeRise]);

  return (
    <View
      style={[
        styles.container,
        compact && styles.compactContainer,
        frameHeight ? { height: frameHeight } : null,
        preloadOnly && styles.preloadOnly,
      ]}
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        if (nextWidth > 0 && Math.abs(nextWidth - frameWidth) > 0.5) {
          setFrameWidth(nextWidth);
        }
      }}
      accessibilityLabel="Oracle en attente"
    >
      <View style={styles.videoFrame}>
        <Image
          source={ORACLE_IMAGE}
          style={styles.video}
          contentFit={compact ? 'contain' : 'cover'}
          transition={0}
          onLoad={() => setImageReady(true)}
          accessibilityLabel="Portrait fixe de l'oracle"
        />
      </View>
      <View style={styles.overlayFrame} pointerEvents="none">
        <Animated.View
          style={[
            styles.candleSmoke,
            compact && styles.compactCandleSmoke,
            {
              opacity: smoke,
              transform: [
                { translateX: smokeDrift.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) },
                {
                  translateY: Animated.add(
                    smokeDrift.interpolate({ inputRange: [-1, 1], outputRange: [5, -12] }),
                    smokeRise.interpolate({ inputRange: [0, 1], outputRange: [5, -22] }),
                  ),
                },
              ],
            },
          ]}
        >
          <View style={[styles.smokePuffOne, compact && styles.compactSmokePuffOne]} />
          <View style={[styles.smokePuffTwo, compact && styles.compactSmokePuffTwo]} />
          <View style={[styles.smokePuffThree, compact && styles.compactSmokePuffThree]} />
        </Animated.View>
      </View>
      {text.trim() ? (
        <View
          style={[styles.textOverlay, compact && styles.compactTextOverlay]}
          pointerEvents="none"
        >
          <View
            style={[styles.textPanel, compact && styles.compactTextPanel]}
            onLayout={(event) => setTextViewportHeight(event.nativeEvent.layout.height)}
          >
            <Animated.View
              style={[
                styles.textScrollContent,
                {
                  transform: [{ translateY: prompterOffsetAnim }],
                },
              ]}
              onLayout={(event) => setTextContentHeight(event.nativeEvent.layout.height)}
            >
              {prompterSentences.map((sentence, index) => {
                const isActive = activePhraseRange
                  ? index >= activePhraseRange.start && index <= activePhraseRange.end
                  : Boolean(activePhrase) && sentence.trim() === activePhrase.trim();
                return (
                  <View
                    key={`${index}-${sentence}`}
                    onLayout={(event) => {
                      const y = event.nativeEvent.layout.y;
                      if (sentenceLayouts.get(index) !== y) {
                        sentenceLayouts.set(index, y);
                        setLayoutTick((tick) => tick + 1);
                      }
                    }}
                  >
                    <Text
                      style={[
                        styles.overlayText,
                        compact && styles.compactOverlayText,
                        index === activeSentenceIndex && styles.activeOverlayText,
                      ]}
                    >
                      {sentence}
                    </Text>
                  </View>
                );
              })}
            </Animated.View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 9 / 16,
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: 24,
    backgroundColor: '#100D20',
  },
  compactContainer: {
    width: '100%',
    aspectRatio: 768 / 1012,
    flexShrink: 0,
    alignSelf: 'center',
    borderRadius: 18,
  },
  layer: {
    ...StyleSheet.absoluteFill,
  },
  videoFrame: {
    ...StyleSheet.absoluteFill,
  },
  video: {
    width: '100%',
    height: '100%',
  },
  nonInteractive: {
    pointerEvents: 'none',
  },
  overlayFrame: {
    ...StyleSheet.absoluteFill,
  },
  candleSmoke: {
    position: 'absolute',
    left: '20%',
    bottom: '9%',
    width: 72,
    height: 130,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  compactCandleSmoke: {
    left: 'auto',
    right: '3%',
    bottom: '13%',
    width: 42,
    height: 88,
  },
  compactSmokePuffOne: {
    bottom: 0,
    width: 18,
    height: 22,
  },
  compactSmokePuffTwo: {
    bottom: 20,
    left: 12,
    width: 24,
    height: 28,
  },
  compactSmokePuffThree: {
    bottom: 45,
    left: 3,
    width: 20,
    height: 24,
  },
  smokePuffOne: {
    position: 'absolute',
    bottom: 22,
    width: 22,
    height: 34,
    borderRadius: 20,
    backgroundColor: 'rgba(235, 224, 218, 0.28)',
    transform: [{ rotate: '-14deg' }],
  },
  smokePuffTwo: {
    position: 'absolute',
    bottom: 48,
    left: 25,
    width: 30,
    height: 42,
    borderRadius: 25,
    backgroundColor: 'rgba(235, 224, 218, 0.2)',
    transform: [{ rotate: '18deg' }],
  },
  smokePuffThree: {
    position: 'absolute',
    bottom: 79,
    left: 12,
    width: 24,
    height: 30,
    borderRadius: 20,
    backgroundColor: 'rgba(235, 224, 218, 0.14)',
  },
  textPanel: {
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 16,
    backgroundColor: 'rgba(7, 5, 20, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  compactTextPanel: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(7, 5, 20, 0.46)',
  },
  textScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    // Keep the final line above the clipped edge when the automatic scroll
    // reaches the end of the prompter.
    paddingBottom: 20,
  },
  textOverlay: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: '5%',
    height: '34%',
    justifyContent: 'flex-start',
  },
  compactTextOverlay: {
    left: 6,
    right: 6,
    bottom: '3%',
    // Leave enough room for the final sentence instead of clipping its
    // descenders against the bottom edge of the compact prompter.
    height: '31%',
  },
  overlayText: {
    color: '#FFF7DF',
    fontSize: 17,
    lineHeight: 25,
    fontFamily: 'Inter_400Regular',
    textShadowColor: 'rgba(0, 0, 0, 0.95)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 5,
  },
  activeOverlayText: {
    color: '#FFFFFF',
    textShadowColor: 'rgba(201, 168, 76, 0.95)',
    textShadowRadius: 8,
  },
  compactOverlayText: {
    fontSize: 13,
    lineHeight: 18,
  },
  preloadOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0.01,
    left: -10,
    top: -10,
  },
});