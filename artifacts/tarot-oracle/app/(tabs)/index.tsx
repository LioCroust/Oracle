import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  ImageBackground,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  useWindowDimensions,
  View,
} from 'react-native';

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAdminAccess } from '@/contexts/AdminAccessContext';
import { useCredits } from '@/contexts/CreditsContext';
import { useOracleReset } from '@/contexts/OracleResetContext';
import { useColors } from '@/hooks/useColors';
import { drawThreeCards, TAROT_CARDS } from '@/constants/cards';
import type { TarotCard as TarotCardType } from '@/constants/cards';
import { AnimatedBalance } from '@/components/AnimatedBalance';
import { AudioButton } from '@/components/AudioButton';
import { SpeakingOracle } from '@/components/SpeakingOracle';
import {
  useCreateTarotReadingDetail,
  useCreateTarotFollowUpQuestions,
  useCreateTarotFollowUpDetail,
} from '@workspace/api-client-react';
import type { TarotReadingContext } from '@workspace/api-client-react';
import { useMutation } from '@tanstack/react-query';
import {
  streamFullReading,
  type FullReadingResponse,
} from '@/lib/fullReading';
import { recordUsageEvent } from '@/lib/adminStorage';
import { markOracleReady, prefetchTts, stopTts } from '@/lib/tts';

const CARD_BACK = require('@/assets/images/cards/card-back.png');

const TAROT_BG = require('@/assets/images/tarot-bg.png');
const ORACLE_LOGO = require('@/assets/images/oracle-logo.jpg');
// One slow, non-looping cinematic sequence. It settles into a waiting pose
// after 10s; the reveal can overlap the final text and TTS preparation.
const DRAW_ANIMATION_DURATION_MS = 10_000;
const DRAW_ORBIT_HOLD_PROGRESS = 0.645;
const DRAW_REVEAL_END_PROGRESS = 0.8;
const DRAW_CARD_SCALE = 1.045;
const DRAW_REVEAL_DURATION_MS = 3_200;
// A long reading can contain many TTS chunks. Reveal the detailed Oracle as
// soon as the first chunk is prepared, while the remaining chunks continue
// warming one request ahead in the background.
const DETAIL_TTS_PREP_TIMEOUT_MS = 8_000;

/**
 * Keep the first reading visual-only: all local card artwork, the background,
 * and the fixed smoky oracle are mounted once while the screen is alive.
 * This makes the first draw decode from memory instead of showing image/video
 * loading between the orbit and the revealed cards.
 */
function VisualAssetPreloader() {
  return (
    <View pointerEvents="none" style={styles.assetPreloader}>
      <Image source={TAROT_BG} style={styles.preloadedAsset} />
      <Image source={ORACLE_LOGO} style={styles.preloadedAsset} />
      <Image source={CARD_BACK} style={styles.preloadedAsset} />
      {TAROT_CARDS.map((card) => (
        <Image key={card.id} source={card.image} style={styles.preloadedAsset} />
      ))}
      <SpeakingOracle status="idle" text="" preloadOnly />
    </View>
  );
}

type DrawnCard = TarotCardType & { position: string; isReversed: boolean };

const POSITION_LABELS: Record<string, string> = {
  Passé: 'PASSÉ',
  Présent: 'PRÉSENT',
  Avenir: 'AVENIR',
};

function generateMockReadings(cards: DrawnCard[], question: string) {
  const names = cards.map((c) => c.name);
  const [past, present, future] = cards;
  const orientation = (card: DrawnCard) => (card.isReversed ? ' à l\'envers' : '');
  const meaning = (card: DrawnCard) => (card.isReversed ? card.reversed : card.upright);

  const shortReading =
    `${names[0]} dans votre passé, ${names[1]} dans votre présent et ${names[2]} dans votre avenir répondent à votre question : « ${question.trim()} ». ` +
    `L'ensemble des trois cartes invite à la confiance et à l'action. Mais l'oracle garde un secret plus précis… pour celui qui ose le débloquer.`;

  const longReading =
    `Le passé est représenté par ${names[0]}${orientation(past)}, ce qui souligne ${meaning(past).toLowerCase()}. ` +
    `Dans le présent, ${names[1]}${orientation(present)} montre que ${meaning(present).toLowerCase()}. ` +
    `Enfin, l'avenir s'ouvre avec ${names[2]}${orientation(future)}, annonçant ${meaning(future).toLowerCase()}. ` +
    `Ces trois énergies se répondent : elles vous invitent à accueillir le passé comme un enseignement, à ancrer le présent comme un choix conscient, et à avancer vers l'avenir avec calme et détermination.`;

  const advice =
    `Faites confiance à ${names[1]} pour éclairer votre décision actuelle. Laissez l'expérience de ${names[0]} guider votre intuition sans la laisser freiner votre élan.`;

  const nextSteps =
    `Prenez un moment pour écrire trois actions concrètes inspirées par ${names[2]}, puis avancez d'un pas cette semaine, même petit.`;

  return { shortReading, longReading, advice, nextSteps };
}

function shadowStyle({
  color,
  offset,
  opacity,
  radius,
  elevation,
}: {
  color: string;
  offset: { width: number; height: number };
  opacity: number;
  radius: number;
  elevation?: number;
}) {
  if (Platform.OS === 'web') {
    return {
      boxShadow: `${offset.width}px ${offset.height}px ${radius}px ${color}`,
    };
  }
  return {
    shadowColor: color,
    shadowOffset: offset,
    shadowOpacity: opacity,
    shadowRadius: radius,
    ...(elevation !== undefined ? { elevation } : {}),
  };
}

// ── Shooting Stars ─────────────────────────────────────────────────────────────

type Edge = 'top' | 'bottom' | 'left' | 'right';

function generateShootingStarConfig() {
  const edges: Edge[] = ['top', 'bottom', 'left', 'right'];
  const edge = edges[Math.floor(Math.random() * edges.length)];
  const along = Math.random() * 100; // position along the chosen edge
  const distance = 160 + Math.random() * 240; // travel distance in dp
  const duration = 1400 + Math.random() * 1600;
  const delay = Math.random() * 4000;
  const size = 2 + Math.random() * 4;

  let startTop: `${number}%`;
  let startLeft: `${number}%`;
  let travelX: number;
  let travelY: number;

  switch (edge) {
    case 'left':
      startLeft = '-4%';
      startTop = `${along}%`;
      travelX = distance;
      travelY = (Math.random() * distance * 0.6) * (Math.random() > 0.5 ? 1 : -1);
      break;
    case 'right':
      startLeft = '100%';
      startTop = `${along}%`;
      travelX = -distance;
      travelY = (Math.random() * distance * 0.6) * (Math.random() > 0.5 ? 1 : -1);
      break;
    case 'top':
      startLeft = `${along}%`;
      startTop = '-4%';
      travelY = distance;
      travelX = (Math.random() * distance * 0.6) * (Math.random() > 0.5 ? 1 : -1);
      break;
    case 'bottom':
      startLeft = `${along}%`;
      startTop = '100%';
      travelY = -distance;
      travelX = (Math.random() * distance * 0.6) * (Math.random() > 0.5 ? 1 : -1);
      break;
  }

  return { edge, startLeft, startTop, travelX, travelY, duration, delay, size };
}

function ShootingStar() {
  const anim = useRef(new Animated.Value(0)).current;
  const config = useRef(generateShootingStarConfig()).current;

  const angle = Math.atan2(config.travelY, config.travelX) * (180 / Math.PI);

  React.useEffect(() => {
    let mounted = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let currentAnim: Animated.CompositeAnimation | null = null;

    const run = () => {
      if (!mounted) return;
      anim.setValue(0);
      const a = Animated.timing(anim, {
        toValue: 1,
        duration: config.duration,
        delay: config.delay,
        easing: Easing.out(Easing.quad),
        useNativeDriver: Platform.OS !== 'web',
      });
      currentAnim = a;
      a.start(() => {
        if (!mounted) return;
        timeout = setTimeout(run, 2500 + Math.random() * 4000);
      });
    };

    run();

    return () => {
      mounted = false;
      if (timeout) clearTimeout(timeout);
      currentAnim?.stop();
    };
  }, [anim, config]);

  const opacity = anim.interpolate({
    inputRange: [0, 0.12, 0.88, 1],
    outputRange: [0, 1, 1, 0],
  });
  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, config.travelX],
  });
  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, config.travelY],
  });

  return (
    <Animated.View
      style={[
        styles.shootingStarHead,
        {
          position: 'absolute',
          top: config.startTop,
          left: config.startLeft,
          width: config.size,
          height: config.size,
          opacity,
          transform: [{ translateX }, { translateY }, { rotate: `${angle}deg` }],
          backgroundColor: 'rgba(255, 245, 210, 1)',
          shadowColor: '#fff',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 1,
          shadowRadius: 5,
          ...(Platform.OS === 'web' ? { boxShadow: '0 0 8px 1px rgba(255,245,210,0.9)' } : {}),
        },
      ]}
      pointerEvents="none"
    />
  );
}

function ShootingStars() {
  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
      {Array.from({ length: 4 }).map((_, i) => (
        <ShootingStar key={i} />
      ))}
    </View>
  );
}

// ── Tarot Card (with flip) ─────────────────────────────────────────────────────

function CardView({
  card,
  flipAnim,
  index,
  cardWidth,
  cardHeight,
  finalRow = false,
}: {
  card: DrawnCard;
  flipAnim: Animated.Value;
  index: number;
  cardWidth: number;
  cardHeight: number;
  finalRow?: boolean;
}) {
  const colors = useColors();
  const cardOverlap = finalRow ? cardWidth * 0.01 : cardWidth * 0.03;
  const useCompactBadges = cardWidth < 138;
  const floatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 2400 + index * 180,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 2400 + index * 180,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    const startTimer = setTimeout(() => loop.start(), index * 160);
    return () => {
      clearTimeout(startTimer);
      loop.stop();
    };
  }, [floatAnim, index]);

  // Smoother scale-based flip instead of a rotateY jump
  const backScale = flipAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 0, 0],
  });
  const frontScale = flipAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, 0, 1],
  });
  const backOpacity = flipAnim.interpolate({
    inputRange: [0, 0.45, 0.55],
    outputRange: [1, 1, 0],
  });
  const frontOpacity = flipAnim.interpolate({
    inputRange: [0.45, 0.55, 1],
    outputRange: [0, 1, 1],
  });

  const cardRotation = finalRow ? '0deg' : index === 0 ? '-7deg' : index === 2 ? '7deg' : '0deg';
  const translateY = finalRow ? 0 : index === 1 ? 0 : cardHeight * 0.04;

  return (
    <Animated.View
      style={[
        styles.cardStage,
        {
          width: cardWidth,
          height: cardHeight,
          marginHorizontal: -cardOverlap,
          transform: [
            { rotate: cardRotation },
            { translateY: flipAnim.interpolate({ inputRange: [0, 1], outputRange: [cardHeight * 0.15, translateY] }) },
            {
              translateY: Animated.multiply(
                floatAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -7],
                }),
                flipAnim,
              ),
            },
          ],
          zIndex: index === 1 ? 3 : 2,
        },
      ]}
    >
      {/* Card shadow / glow */}
      <View
        style={[
          styles.cardGlow,
          shadowStyle({
            color: card.color,
            offset: { width: 0, height: 8 },
            opacity: 0.55,
            radius: 22,
            elevation: 10,
          }),
        ]}
      />

      {/* Back side */}
      <Animated.View
        style={[
          styles.cardSide,
          { opacity: backOpacity, transform: [{ scaleX: backScale }] },
        ]}
      >
        <Image
          source={CARD_BACK}
          style={styles.cardImage}
          contentFit="cover"
          transition={0}
        />
      </Animated.View>

        {/* Front side */}
      <Animated.View
        style={[
          styles.cardSide,
          {
            opacity: frontOpacity,
            transform: [{ scaleX: frontScale }],
          },
        ]}
      >
        <Image
          source={card.image}
          style={[
            styles.cardImage,
            card.isReversed && styles.cardImageReversed,
          ]}
          contentFit="cover"
          transition={0}
        />

        {/* Position badge */}
        <View
          style={[
            styles.positionBadge,
            useCompactBadges && styles.positionBadgeCompact,
            { backgroundColor: card.color },
          ]}
        >
        <Text style={[styles.positionBadgeText, useCompactBadges && styles.positionBadgeTextCompact]}>
            {POSITION_LABELS[card.position] ?? card.position.toUpperCase()}
          </Text>
        </View>

        {/* Orientation badge */}
        <View
          style={[
            styles.orientationBadge,
            useCompactBadges && styles.orientationBadgeCompact,
            {
              backgroundColor: card.isReversed
                ? 'rgba(200, 100, 80, 0.72)'
                : 'rgba(100, 180, 120, 0.72)',
            },
          ]}
        >
          <Feather
            name={card.isReversed ? 'arrow-down' : 'arrow-up'}
            size={10}
            color="#fff"
          />
          <Text style={[styles.orientationText, useCompactBadges && styles.orientationTextCompact]}>
            {card.isReversed ? 'Renversé' : 'Droit'}
          </Text>
        </View>
        <View style={styles.cardLabelOverlay}>
          <Text style={styles.cardLabelName}>{card.name}</Text>
          <Text style={styles.cardLabelTheme}>{card.theme}</Text>
        </View>
        </Animated.View>

    </Animated.View>
  );
}

// ── Card Back (pre-draw placeholder) ─────────────────────────────────────────────

function CardBack({
  index,
  cardWidth,
  cardHeight,
}: {
  index: number;
  cardWidth: number;
  cardHeight: number;
}) {
  const floatAnim = useRef(new Animated.Value(0)).current;
  const cardOverlap = cardWidth * 0.03;
  const cardRotation = index === 0 ? '-7deg' : index === 2 ? '7deg' : '0deg';
  const translateY = index === 1 ? 0 : cardHeight * 0.04;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 2200 + index * 200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 2200 + index * 200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    const startTimer = setTimeout(() => loop.start(), index * 180);
    return () => {
      clearTimeout(startTimer);
      loop.stop();
    };
  }, [floatAnim, index]);

  return (
    <Animated.View
      style={[
        styles.cardStage,
        {
          width: cardWidth,
          height: cardHeight,
          marginHorizontal: -cardOverlap,
          transform: [
            { rotate: cardRotation },
            { translateY },
            {
              translateY: floatAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, -8],
              }),
            },
          ],
          zIndex: index === 1 ? 3 : 2,
        },
      ]}
    >
      <View
        style={[
          styles.cardGlow,
          shadowStyle({
            color: '#C9A84C',
            offset: { width: 0, height: 8 },
            opacity: 0.35,
            radius: 22,
            elevation: 10,
          }),
        ]}
      />
      <View style={[styles.cardSide, { opacity: 1 }]}>
        <Image
          source={CARD_BACK}
          style={styles.cardImage}
          contentFit="cover"
          transition={0}
        />
      </View>
    </Animated.View>
  );
}

// ── Pulse Orbit Loading (real card images) ──────────────────────────────────────

function PulseOrbitCards({
  cards,
  cardWidth,
  cardHeight,
  large = false,
}: {
  cards: DrawnCard[];
  cardWidth: number;
  cardHeight: number;
  large?: boolean;
}) {
  const colors = useColors();
  const orbitAngle = useRef(new Animated.Value(0)).current;
  const radiusX = cardWidth * (large ? 0.95 : 1.15);
  const radiusY = cardHeight * (large ? 0.18 : 0.22);
  const targetCardWidth = cardWidth * (large ? 0.9 : 0.55);
  const targetCardHeight = cardHeight * (large ? 0.9 : 0.55);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(orbitAngle, {
        toValue: 1,
        duration: 5000,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();

    return () => {
      loop.stop();
    };
  }, [orbitAngle]);

  const AnimatedImage = Animated.createAnimatedComponent(Image);
  const orbitSamples = [0, 0.25, 0.5, 0.75, 1];

  return (
    <View style={[styles.pulseOrbitContainer, { height: cardHeight * (large ? 1.55 : 1.1) }]}>
      <View style={[styles.pulseOrbitGlow, { backgroundColor: hexToRgba(colors.primary, 0.08) }]} />
      <View style={[styles.pulseOrbitGlowSmall, { backgroundColor: hexToRgba(colors.accent, 0.12) }]} />
      {cards.map((card, i) => {
        const phase = i / cards.length;
        const samples = orbitSamples.map((sample) => {
          const angle = ((sample + phase) % 1) * 2 * Math.PI;
          const depth = (Math.sin(angle) + 1) / 2;
          return {
            x: Math.cos(angle) * radiusX,
            y: Math.sin(angle) * radiusY,
            scale: large ? 1 : 0.72 + 0.38 * depth,
            opacity: large ? 1 : 0.45 + 0.55 * depth,
          };
        });
        return (
          <Animated.View
            key={`pulse-${card.id}-${i}`}
            style={[
              styles.pulseOrbitCardWrapper,
              {
                width: targetCardWidth,
                height: targetCardHeight,
                transform: [
                  {
                    translateX: orbitAngle.interpolate({
                      inputRange: orbitSamples,
                      outputRange: samples.map((s) => s.x),
                    }),
                  },
                  {
                    translateY: orbitAngle.interpolate({
                      inputRange: orbitSamples,
                      outputRange: samples.map((s) => s.y),
                    }),
                  },
                  {
                    scale: orbitAngle.interpolate({
                      inputRange: orbitSamples,
                      outputRange: samples.map((s) => s.scale),
                    }),
                  },
                ],
                opacity: orbitAngle.interpolate({
                  inputRange: orbitSamples,
                  outputRange: samples.map((s) => s.opacity),
                }),
                zIndex: i + 1,
              },
            ]}
            pointerEvents="none"
          >
            <View style={[styles.pulseOrbitCardShadow, { backgroundColor: hexToRgba(card.color, 0.55) }]} />
            <AnimatedImage
              source={card.image}
              style={[
                styles.pulseOrbitCardImage,
                card.isReversed && styles.cardImageReversed,
              ]}
              contentFit="cover"
              transition={0}
            />
          </Animated.View>
        );
      })}
      <View style={styles.pulseOrbitCaptionBox}>
        <View style={styles.pulseOrbitDots}>
          <View style={[styles.pulseOrbitDot, { backgroundColor: colors.primary }]} />
          <View style={[styles.pulseOrbitDot, { backgroundColor: colors.primary }]} />
          <View style={[styles.pulseOrbitDot, { backgroundColor: colors.primary }]} />
        </View>
        <Text style={[styles.pulseOrbitCaption, { color: colors.primary }]}>L'oracle consulte les cartes…</Text>
      </View>
    </View>
  );
}

// Long cinematic draw: the cards mix for most of the sequence, flip in place
// without slowing the individual flip, then settle slowly into a large,
// nearly-touching portrait row that spans the frame.
function LongOrbitCards({
  cards,
  cardWidth,
  cardHeight,
  revealRequested,
  onRevealComplete,
}: {
  cards: DrawnCard[];
  cardWidth: number;
  cardHeight: number;
  revealRequested: boolean;
  onRevealComplete: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const revealStartedRef = useRef(false);
  const revealRequestedRef = useRef(revealRequested);
  const orbitFinishedRef = useRef(false);
  const floatAnimLeft = useRef(new Animated.Value(0)).current;
  const floatAnimCenter = useRef(new Animated.Value(0)).current;
  const floatAnimRight = useRef(new Animated.Value(0)).current;
  const cardFloatAnims = [floatAnimLeft, floatAnimCenter, floatAnimRight];

  useEffect(() => {
    const loops = cardFloatAnims.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 1900 + index * 180,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: 1900 + index * 180,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
      ),
    );
    const timers = loops.map((loop, index) =>
      setTimeout(() => loop.start(), index * 160),
    );
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      loops.forEach((loop) => loop.stop());
    };
  }, [floatAnimCenter, floatAnimLeft, floatAnimRight]);

  const startReveal = useCallback(() => {
    if (revealStartedRef.current) return;
    revealStartedRef.current = true;
    animationRef.current?.stop();

    const reveal = Animated.timing(progress, {
      toValue: DRAW_REVEAL_END_PROGRESS,
      duration: DRAW_REVEAL_DURATION_MS,
      easing: Easing.linear,
      useNativeDriver: Platform.OS !== 'web',
    });
    animationRef.current = reveal;
    reveal.start(({ finished }) => {
      if (finished) onRevealComplete();
    });
  }, [onRevealComplete, progress]);

  useEffect(() => {
    const sequence = Animated.timing(progress, {
      toValue: DRAW_ORBIT_HOLD_PROGRESS,
      duration: DRAW_ANIMATION_DURATION_MS,
      // OrbitLaser uses cubic-bezier(.34, .02, .22, 1) for all three
      // trajectories. Keep the native master clock on the same curve.
      easing: Easing.bezier(0.34, 0.02, 0.22, 1),
      useNativeDriver: Platform.OS !== 'web',
    });
    animationRef.current = sequence;
    sequence.start(({ finished }) => {
      orbitFinishedRef.current = finished;
      if (finished && revealRequestedRef.current) {
        startReveal();
      }
    });
    return () => {
      sequence.stop();
      animationRef.current = null;
    };
  }, [progress, startReveal]);

  useEffect(() => {
    revealRequestedRef.current = revealRequested;
    if (revealRequested && orbitFinishedRef.current) {
      startReveal();
    }
  }, [revealRequested, startReveal]);

  return (
    <View style={[styles.longOrbitContainer, { height: cardHeight * 2.45 }]}>
      <Animated.View
        style={[
          styles.longOrbitHalo,
          {
            opacity: progress.interpolate({
              inputRange: [0, 0.25, 0.5, 0.75, 1],
              outputRange: [0.2, 0.5, 0.1, 0.5, 0.2],
            }),
            transform: [{
              scale: progress.interpolate({
                inputRange: [0, 0.25, 0.5, 0.75, 1],
                outputRange: [1, 1.4, 0.8, 1.4, 1],
              }),
            }],
          },
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.longOrbitCurve,
          {
            width: cardWidth * 2.85,
            height: cardHeight * 1.1,
            opacity: progress.interpolate({
              inputRange: [0, 0.12, 0.32, 0.58, DRAW_ORBIT_HOLD_PROGRESS, 1],
              outputRange: [0.08, 0.28, 0.68, 0.38, 0.16, 0.05],
            }),
            transform: [
              { translateX: -(cardWidth * 2.85) / 2 },
              { rotate: '-10deg' },
            ],
          },
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.longOrbitCurve,
          styles.longOrbitCurveCross,
          {
            width: cardWidth * 2.55,
            height: cardHeight * 1.45,
            opacity: progress.interpolate({
              inputRange: [0, 0.18, 0.42, 0.62, DRAW_ORBIT_HOLD_PROGRESS, 1],
              outputRange: [0.04, 0.22, 0.56, 0.3, 0.12, 0.04],
            }),
            transform: [
              { translateX: -(cardWidth * 2.55) / 2 },
              { rotate: '42deg' },
            ],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.longOrbitMagneticField,
          {
            opacity: progress.interpolate({
              inputRange: [0, 0.25, 0.3, 0.42, 0.57, 0.64, 1],
              outputRange: [0, 0, 0.9, 0.9, 0.75, 0, 0],
            }),
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange: [0, 0.42, 0.5, 0.57, 0.64, 1],
                  outputRange: [0, 14, -16, 10, 0, 0],
                }),
              },
              {
                translateY: progress.interpolate({
                  inputRange: [0, 0.42, 0.5, 0.57, 0.64, 1],
                  outputRange: [0, -12, 10, 14, 0, 0],
                }),
              },
              {
                rotate: progress.interpolate({
                  inputRange: [0, 0.42, 0.5, 0.57, 0.64, 1],
                  outputRange: ['0deg', '18deg', '-22deg', '16deg', '0deg', '0deg'],
                }),
              },
            ],
          },
        ]}
      />
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={`orbit-star-${i}`}
          style={[
            styles.longOrbitStar,
            i === 0 ? { left: '29%', top: '34%' } : i === 1 ? { left: '66%', top: '43%' } : { left: '42%', top: '62%' },
            {
              opacity: progress.interpolate({
                inputRange: [0, 0.22, 0.35, 0.55, 0.66, 1],
                outputRange: [0, 0, 0.8, 0.25, 0, 0],
              }),
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 0.35, 0.55, 0.66, 1],
                    outputRange: [0, 0, 24, 38, 38],
                  }),
                },
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 0.35, 0.55, 0.66, 1],
                    outputRange: [0, 0, -32, -44, -44],
                  }),
                },
                {
                  scale: progress.interpolate({
                    inputRange: [0, 0.35, 0.55, 0.66, 1],
                    outputRange: [0.4, 1, 1.25, 0.7, 0.7],
                  }),
                },
              ],
            },
          ]}
        />
      ))}
      {cards.map((card, index) => {
        // These samples mirror OrbitLaser.tsx's three independent CSS
        // trajectories. The reveal starts at 64.5% of the 15.5s master
        // timeline, exactly where the mockup settles before flipping.
        const trajectory = [
          {
            progress: [0, 0.08, 0.2, 0.34, 0.48, 0.58, DRAW_ORBIT_HOLD_PROGRESS],
            x: [40, 40, 126, 70, -34, -6, 0],
            y: [54, 54, -18, -68, -28, 5, 8],
            rotation: [30, 30, 77, 32, -25, -9, -8],
            scale: [0.72, 0.72, 0.72, 0.68, 0.7, 1, 1],
          },
          {
            progress: [0, 0.1, 0.22, 0.38, 0.52, 0.61, DRAW_ORBIT_HOLD_PROGRESS],
            x: [-26, -26, -98, -2, 91, 0, 0],
            y: [10, 10, -66, -106, -48, -2, -2],
            rotation: [-26, -26, -68, 2, 56, 0, 0],
            scale: [0.76, 0.76, 0.7, 0.66, 0.72, 1, 1],
          },
          {
            progress: [0, 0.12, 0.25, 0.42, 0.55, 0.62, DRAW_ORBIT_HOLD_PROGRESS],
            x: [-44, -44, -126, -61, 35, 5, 0],
            y: [63, 63, -20, -87, -32, 8, 8],
            rotation: [-35, -35, -80, -25, 32, 8, 8],
            scale: [0.72, 0.72, 0.7, 0.68, 0.73, 1, 1],
          },
        ][index];
        const slotX = index === 0 ? -cardWidth * 0.99 : index === 2 ? cardWidth * 0.99 : 0;
        const orbitTranslateX = progress.interpolate({
          inputRange: trajectory.progress,
          outputRange: trajectory.x.map((value) => value * (cardWidth / 106) + slotX),
          extrapolate: 'clamp',
        });
        const orbitTranslateY = progress.interpolate({
          inputRange: trajectory.progress,
          outputRange: trajectory.y.map((value) => value * (cardWidth / 106)),
          extrapolate: 'clamp',
        });
        const orbitRotation = progress.interpolate({
          inputRange: trajectory.progress,
          outputRange: trajectory.rotation.map((value) => `${value}deg`),
          extrapolate: 'clamp',
        });
        const orbitScale = progress.interpolate({
          inputRange: trajectory.progress,
          outputRange: trajectory.scale.map((value) => value * DRAW_CARD_SCALE),
          extrapolate: 'clamp',
        });
        const flipStart = [0.66, 0.695, 0.73][index];
        const flip = progress.interpolate({
          inputRange: [flipStart, flipStart + 0.03, flipStart + 0.06],
          outputRange: [0, 0.5, 1],
          extrapolate: 'clamp',
        });
        const cardFloatY = cardFloatAnims[index].interpolate({
          inputRange: [0, 1],
          outputRange: [0, -8],
        });
        const backFloatY = flip.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0],
          extrapolate: 'clamp',
        });
        const backScale = flip.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 0] });
        const frontScale = flip.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.02, 0, 1] });
        const backOpacity = flip.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1, 0] });
        const frontOpacity = flip.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 1] });

        return (
          <Animated.View
            key={`long-orbit-${card.id}-${index}`}
            style={[
              styles.longOrbitCard,
              {
                width: cardWidth,
                height: cardHeight,
                left: '50%',
                top: cardHeight * 0.84,
                marginLeft: -cardWidth / 2,
                marginTop: -cardHeight / 2,
                transform: [
                  { translateX: orbitTranslateX },
                  { translateY: Animated.add(orbitTranslateY, Animated.multiply(cardFloatY, backFloatY)) },
                  { rotate: orbitRotation },
                  { scale: orbitScale },
                ],
                zIndex: index + 1,
              },
            ]}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                styles.longOrbitCardLight,
                {
                  backgroundColor: hexToRgba(card.color, 0.72),
                  opacity: progress.interpolate({
                    inputRange:
                      index === 0
                        ? [0, 0.64, 0.69, 0.75, 1]
                        : index === 1
                          ? [0, 0.68, 0.74, 0.8, 1]
                          : [0, 0.72, 0.78, 0.84, 1],
                    outputRange: [0, 0, 0.9, 0, 0],
                  }),
                },
              ]}
            />
            <Animated.View style={[styles.cardSide, { opacity: backOpacity, transform: [{ scaleX: backScale }] }]}>
              <Image source={CARD_BACK} style={styles.cardImage} contentFit="cover" transition={0} />
            </Animated.View>
            <Animated.View style={[styles.cardSide, { opacity: frontOpacity, transform: [{ scaleX: frontScale }] }]}>
              <Image source={card.image} style={[styles.cardImage, card.isReversed && styles.cardImageReversed]} contentFit="cover" transition={0} />
              <View style={styles.cardLabelOverlay}>
                <Text style={styles.cardLabelName}>{card.name}</Text>
                <Text style={styles.cardLabelTheme}>{card.theme}</Text>
              </View>
            </Animated.View>
          </Animated.View>
        );
      })}
      <Animated.View
        style={[
          styles.longOrbitCaption,
          {
            opacity: progress.interpolate({
              inputRange: [0, 0.94, 0.97, 0.99, 1],
              outputRange: [0, 0, 1, 1, 0],
            }),
          },
        ]}
      >
        <View style={styles.pulseOrbitDots}>
          <View style={styles.pulseOrbitDot} />
          <View style={styles.pulseOrbitDot} />
          <View style={styles.pulseOrbitDot} />
        </View>
        <Text style={styles.longOrbitCaptionText}>L’oracle consulte les cartes…</Text>
      </Animated.View>
    </View>
  );
}

// ── Highlighted Text ───────────────────────────────────────────────────────────

function HighlightedText({
  text,
  highlightWords,
  baseStyle,
  highlightStyle,
  numberOfLines,
}: {
  text: string;
  highlightWords?: string[];
  baseStyle: StyleProp<TextStyle>;
  highlightStyle: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const words = (highlightWords ?? []).map((w) => w.trim()).filter(Boolean);
  const parts = useMemo(() => {
    if (!words.length) return [text];
    const sorted = [...words].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    return text.split(regex);
  }, [text, words.join('|')]);

  if (!words.length) {
    return (
      <Text style={baseStyle} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }

  return (
    <Text style={baseStyle} numberOfLines={numberOfLines}>
      {parts.map((part, i) => {
        const isHighlighted = words.some(
          (w) => w.toLowerCase() === part.toLowerCase(),
        );
        return isHighlighted ? (
          <Text key={i} style={highlightStyle}>
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        );
      })}
    </Text>
  );
}

// ── Shooting Star Icon ─────────────────────────────────────────────────────────

function ShootingStarIcon({ color, size = 16 }: { color: string; size?: number }) {
  return (
    <View style={[styles.shootingStarIcon, { width: size, height: size, marginRight: 8 }]}>
      <View
        style={[
          styles.starHead,
          {
            backgroundColor: color,
            width: size * 0.35,
            height: size * 0.35,
            borderRadius: (size * 0.35) / 2,
            right: size * 0.05,
            top: size * 0.05,
          },
        ]}
      />
      <View
        style={[
          styles.starTail,
          {
            backgroundColor: color,
            width: size * 0.85,
            height: Math.max(2, size * 0.12),
            left: 0,
            bottom: size * 0.15,
          },
        ]}
      />
    </View>
  );
}

// ── Reading Section ────────────────────────────────────────────────────────────

function ReadingSection({
  title,
  text,
  highlightWords = [],
  isLocked,
  onUnlock,
  isLoading,
  fadeAnim,
  variant = 'default',
  unlockCost,
  audioText,
  prompterText,
  framedText,
  showSpeakingOracle = false,
  autoPlayEnabled = true,
  onOracleReady,
  oracleAnchorRef,
}: {
  title: string;
  text: string;
  highlightWords?: string[];
  isLocked?: boolean;
  onUnlock?: () => void;
  isLoading?: boolean;
  fadeAnim: Animated.Value;
  variant?: 'default' | 'gold' | 'accent';
  unlockCost?: number;
  /** Optional text fed to the AudioButton — defaults to `text` when omitted. */
  audioText?: string;
  /** Text shown in the cinematic Oracle prompter. */
  prompterText?: string;
  /** Optional quick-reading text shown in a framed block above the Oracle. */
  framedText?: string;
  /** Shows the cinematic Oracle with its synchronized prompter. */
  showSpeakingOracle?: boolean;
  /** Keeps auto-play disabled while the streamed JSON string is incomplete. */
  autoPlayEnabled?: boolean;
  onOracleReady?: () => void | Promise<void>;
  oracleAnchorRef?: React.RefObject<View | null>;
}) {
  const colors = useColors();
  const [audioStatus, setAudioStatus] = useState<import('@/lib/tts').TtsStatus>('idle');
  const [oracleReadyForText, setOracleReadyForText] = useState('');
  const oracleReadyPendingRef = useRef('');
  const accent =
    variant === 'gold' ? colors.primary : variant === 'accent' ? colors.accent : colors.primary;

  const textStyle = [styles.readingText, { color: colors.foreground }];
  const highlightStyle = [styles.readingText, { color: accent, fontWeight: '700' as const }];

  const spokenText = prompterText ?? audioText ?? text;
  const hasSpeakingText = showSpeakingOracle && spokenText.trim().length > 0;
  const hasFramedText = hasSpeakingText && Boolean(framedText?.trim());
  const canRead = !isLoading && !isLocked && spokenText.trim().length > 0;
  const handleOracleReady = async () => {
    if (
      !spokenText.trim() ||
      oracleReadyForText === spokenText ||
      oracleReadyPendingRef.current === spokenText
    ) {
      return;
    }
    oracleReadyPendingRef.current = spokenText;
    await onOracleReady?.();
    if (oracleReadyPendingRef.current !== spokenText) return;
    markOracleReady(spokenText);
    oracleReadyPendingRef.current = '';
    setOracleReadyForText(spokenText);
  };

  return (
    <>
      {!showSpeakingOracle ? (
        <Animated.View
          style={[
            styles.readingSection,
            {
              backgroundColor: 'rgba(139, 124, 200, 0.14)',
              borderColor: hexToRgba(colors.accent, 0.35),
              opacity: fadeAnim,
              transform: [
                {
                  translateY: fadeAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [20, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={styles.readingHeaderRow}>
            <View style={styles.readingHeader}>
              <ShootingStarIcon color={accent} />
              <Text style={[styles.readingTitle, { color: accent }]}>{title}</Text>
            </View>
            {canRead ? (
              <AudioButton
                text={audioText ?? text}
                accent={accent}
                compact
                onPlaybackStateChange={setAudioStatus}
                autoPlay={autoPlayEnabled}
              />
            ) : null}
          </View>

          {isLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={accent} />
              <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
                Les cartes parlent…
              </Text>
            </View>
          ) : isLocked ? (
            <View>
              <HighlightedText
                text={text}
                highlightWords={highlightWords}
                baseStyle={textStyle}
                highlightStyle={highlightStyle}
              />
              <Pressable
                style={({ pressed }) => [
                  styles.unlockButton,
                  {
                    backgroundColor: pressed ? hexToRgba(accent, 0.8) : accent,
                    borderColor: accent,
                  },
                ]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  onUnlock?.();
                }}
              >
                <Text style={[styles.unlockButtonText, { color: colors.primaryForeground }]}>
                  Débloquer la lecture — {unlockCost ?? 40} crédits
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <HighlightedText
                text={text}
                highlightWords={highlightWords}
                baseStyle={textStyle}
                highlightStyle={highlightStyle}
              />
            </>
          )}
        </Animated.View>
      ) : null}
      {hasSpeakingText ? (
        <View
          style={styles.oracleStandalone}
          onLayout={handleOracleReady}
        >
          {hasFramedText ? (
            <View
              style={[
                styles.quickReadingFrame,
                {
                  backgroundColor: 'rgba(139, 124, 200, 0.14)',
                  borderColor: hexToRgba(colors.accent, 0.35),
                },
              ]}
            >
              <View style={styles.quickReadingFrameHeader}>
                <ShootingStarIcon color={colors.accent} size={14} />
                <Text style={[styles.quickReadingFrameTitle, { color: colors.accent }]}>
                  LECTURE RAPIDE
                </Text>
              </View>
              <HighlightedText
                text={framedText ?? ''}
                highlightWords={highlightWords}
                baseStyle={[styles.miniText, { color: colors.foreground }]}
                highlightStyle={[
                  styles.miniText,
                  { color: colors.accent, fontWeight: '700' as const },
                ]}
              />
            </View>
          ) : null}
          <View ref={oracleAnchorRef} style={styles.oracleFrame}>
            <SpeakingOracle
              status={audioStatus}
              text={spokenText}
              compact
              onReady={handleOracleReady}
            />
          </View>
          {canRead ? (
            <View style={styles.oracleReplayButton}>
              <AudioButton
                text={spokenText}
                accent={accent}
                compact
                label="Réécouter"
                // Wait until the scroll/layout pass has completed and the
                // Oracle is visible. The TTS warmup continues during this
                // settling window, so the first phrase starts from cache.
                autoPlay={autoPlayEnabled && oracleReadyForText === spokenText}
                autoPlayDelayMs={0}
                onPlaybackStateChange={setAudioStatus}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

// ── Main Screen ─────────────────────────────────────────────────────────────────

export default function OracleScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { unlockAdmin } = useAdminAccess();
  const {
    balance,
    canReadShort,
    canReadDetail,
    canAskFollowUpQuestions,
    canAskFollowUpDetail,
    canAskFollowUpSuggestedDetail,
    shortCost,
    detailCost,
    followUpQuestionsCost,
    followUpDetailCost,
    followUpSuggestedDetailCost,
    spendShort,
    spendDetail,
    spendFollowUpQuestions,
    spendFollowUpDetail,
    spendFollowUpSuggestedDetail,
    refund,
  } = useCredits();

  const lastLogoPress = useRef<number>(0);
  const handleLogoPress = useCallback(() => {
    const now = Date.now();
    if (now - lastLogoPress.current < 350) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      unlockAdmin();
      router.push('/admin');
    }
    lastLogoPress.current = now;
  }, [router, unlockAdmin]);

  const [question, setQuestion] = useState('');
  const [showQuestionHint, setShowQuestionHint] = useState(false);
  const questionHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionHintEntrance = useRef(new Animated.Value(0)).current;
  const questionHintDisperse = useRef(new Animated.Value(0)).current;
  const [drawnCards, setDrawnCards] = useState<DrawnCard[] | null>(null);
  const [shortReading, setShortReading] = useState<string | null>(null);
  const [shortReadingComplete, setShortReadingComplete] = useState(false);
  const [longReading, setLongReading] = useState<string | null>(null);
  const [advice, setAdvice] = useState<string | null>(null);
  const [nextSteps, setNextSteps] = useState<string | null>(null);
  const [isLongUnlocked, setIsLongUnlocked] = useState(false);
  // stagedSuggestedQuestions are pre-fetched by the single-call full
  // reading endpoint so the mobile doesn't need a second /follow-up-questions
  // round-trip to power the suggested follow-ups rail.
  const [stagedSuggestedQuestions, setStagedSuggestedQuestions] = useState<
    string[]
  >([]);
  // stagedLongReading / stagedAdvice / stagedNextSteps are the single-call
  // wave's pre-paid payload for the detailed reading. They stay behind the
  // "locked" overlay until the user pays `detailCost`; only then does
  // handleUnlock() copy them into the *visible* longReading / advice /
  // nextSteps state used by ReadingSection + the mini cards. This keeps the
  // locked teaser copy on screen until the user opts in.
  const [stagedLongReading, setStagedLongReading] = useState<string | null>(
    null,
  );
  const [stagedAdvice, setStagedAdvice] = useState<string | null>(null);
  const [stagedNextSteps, setStagedNextSteps] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [drawRevealRequested, setDrawRevealRequested] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isDetailTtsPrepared, setIsDetailTtsPrepared] = useState(false);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isMockMode, setIsMockMode] = useState(false);
  const [visualAssetsReady, setVisualAssetsReady] = useState(true);
  const drawRevealResolverRef = useRef<(() => void) | null>(null);
  const drawRevealCompletedRef = useRef(false);
  const detailTtsPrepRunRef = useRef(0);

  useEffect(() => {
    // VisualAssetPreloader is mounted in the loading shell below. Keeping it
    // mounted for a full frame window lets expo-image and expo-video decode
    // the bundled assets before any card can be revealed.
    setVisualAssetsReady(true);
  }, []);

  const clearQuestionHintTimer = useCallback(() => {
    if (questionHintTimerRef.current) {
      clearTimeout(questionHintTimerRef.current);
      questionHintTimerRef.current = null;
    }
  }, []);

  const dismissQuestionHint = useCallback(() => {
    clearQuestionHintTimer();
    questionHintEntrance.stopAnimation();
    questionHintDisperse.stopAnimation();
    Animated.timing(questionHintDisperse, {
      toValue: 1,
      duration: 560,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => {
      if (finished) setShowQuestionHint(false);
    });
  }, [
    clearQuestionHintTimer,
    questionHintDisperse,
    questionHintEntrance,
  ]);

  const showQuestionHintWithAnimation = useCallback(() => {
    clearQuestionHintTimer();
    questionHintEntrance.stopAnimation();
    questionHintDisperse.stopAnimation();
    questionHintEntrance.setValue(0);
    questionHintDisperse.setValue(0);
    setShowQuestionHint(true);
    Animated.timing(questionHintEntrance, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    questionHintTimerRef.current = setTimeout(dismissQuestionHint, 6000);
  }, [
    clearQuestionHintTimer,
    dismissQuestionHint,
    questionHintDisperse,
    questionHintEntrance,
  ]);

  useEffect(
    () => () => {
      clearQuestionHintTimer();
      questionHintEntrance.stopAnimation();
      questionHintDisperse.stopAnimation();
    },
    [clearQuestionHintTimer, questionHintDisperse, questionHintEntrance],
  );

  const handleDrawRevealComplete = useCallback(() => {
    drawRevealCompletedRef.current = true;
    const resolve = drawRevealResolverRef.current;
    drawRevealResolverRef.current = null;
    resolve?.();
  }, []);

  const [followUpQuestions, setFollowUpQuestions] = useState<string[] | null>(null);
  const [followUpDetail, setFollowUpDetail] = useState<{
    longReading: string;
    advice: string;
    nextSteps: string;
  } | null>(null);
  const [isFollowUpQuestionsLoading, setIsFollowUpQuestionsLoading] = useState(false);
  const [isFollowUpDetailLoading, setIsFollowUpDetailLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [customFollowUpQuestion, setCustomFollowUpQuestion] = useState('');
  const [isCustomFollowUpVisible, setIsCustomFollowUpVisible] = useState(false);
  const [followUpDetailFor, setFollowUpDetailFor] = useState<string | null>(null);
  const [followUpContext, setFollowUpContext] = useState<TarotReadingContext | null>(null);
  const [followUpQuestionsGenerated, setFollowUpQuestionsGenerated] = useState(false);
  const { resetKey } = useOracleReset();
  const prevResetKey = useRef(resetKey);

  const cardFlipAnims = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  const cardUnlockAnims = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  const readingAnim = useRef(new Animated.Value(0)).current;
  const longReadingAnim = useRef(new Animated.Value(0)).current;
  const adviceAnim = useRef(new Animated.Value(0)).current;
  const detailPulseAnim = useRef(new Animated.Value(0)).current;
  const logoFloatAnim = useRef(new Animated.Value(0)).current;
  const followUpQuestionsAnim = useRef(new Animated.Value(0)).current;
  const followUpDetailAnim = useRef(new Animated.Value(0)).current;
  const scrollViewRef = useRef<ScrollView>(null);
  const customInputRef = useRef<TextInput>(null);
  const followUpSectionRef = useRef<View>(null);
  const cardsSpreadRef = useRef<View>(null);
  const oracleSectionRef = useRef<View>(null);
  const scrollViewportRef = useRef<View>(null);
  const scrollOffsetRef = useRef(0);
  const scrollToTopTriggered = useRef(false);
  const oracleScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oracleScrollResolveRef = useRef<(() => void) | null>(null);

  const finishDrawWithReading = useCallback(
    async ({
      short,
      detailed,
      adviceText,
      next,
      suggested,
    }: {
      short: string;
      detailed: string;
      adviceText: string;
      next: string;
      suggested: string[];
    }) => {
      // The reveal may already have been requested as soon as the first stable
      // streamed text arrived. In that case the animation has been running
      // while the remaining JSON and TTS blocks were being prepared.
      if (!drawRevealCompletedRef.current) {
        await new Promise<void>((resolve) => {
          drawRevealResolverRef.current = resolve;
          setDrawRevealRequested(true);
        });
      }

      cardFlipAnims.forEach((anim) => anim.setValue(1));
      setReadingError(null);
      setShortReading(short);
      setShortReadingComplete(true);
      setIsLoading(false);
      readingAnim.setValue(1);
      setStagedLongReading(detailed);
      setStagedAdvice(adviceText);
      setStagedNextSteps(next);
      setStagedSuggestedQuestions(suggested);
    },
    [cardFlipAnims],
  );

  const scrollToTop = useCallback(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 150);
  }, []);

  const scrollToCards = useCallback(() => {
    setTimeout(() => {
      cardsSpreadRef.current?.measureLayout(
        scrollViewRef.current as unknown as number,
        (_x, y, _width, _height) => {
          scrollViewRef.current?.scrollTo({ y: Math.max(0, y - 120), animated: true });
        },
        () => {},
      );
    }, 100);
  }, []);

  const scrollToOracle = useCallback(() => {
    oracleScrollResolveRef.current?.();
    oracleScrollResolveRef.current = null;
    if (oracleScrollTimerRef.current) clearTimeout(oracleScrollTimerRef.current);
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (oracleScrollResolveRef.current === finish) {
          oracleScrollResolveRef.current = null;
        }
        resolve();
      };
      oracleScrollResolveRef.current = finish;
      oracleScrollTimerRef.current = setTimeout(() => {
        let attempt = 0;
        const measure = () => {
          attempt += 1;
          // The header is outside the scroll viewport. Align the top of the
          // Oracle photo with the top of that viewport so it sits immediately
          // below the ORACLE title instead of leaving the cards as the focal
          // point after the detailed reading is revealed.
          const target = oracleSectionRef.current;
          const scroll = scrollViewRef.current;
          const viewport = scrollViewportRef.current;
          if (!target || !scroll || !viewport) {
            if (attempt < 8) {
              oracleScrollTimerRef.current = setTimeout(measure, 120);
            } else {
              finish();
            }
            return;
          }
          target.measureInWindow((_x, targetY) => {
            viewport.measureInWindow(
              (_scrollX: number, scrollY: number, _width: number, _height: number) => {
                const currentOffset = scrollOffsetRef.current;
                const oracleDocumentY = currentOffset + targetY - scrollY;
                const nextOffset = Math.max(0, oracleDocumentY - 4);
                if (attempt >= 3 || nextOffset > 0) {
                  // ScrollView does not expose an animation duration. Use a
                  // short, one-shot eased transition so the Oracle arrives
                  // gently below the title instead of snapping there.
                  const startOffset = scrollOffsetRef.current;
                  const distance = nextOffset - startOffset;
                  const startedAt = Date.now();
                  const durationMs = 650;
                  const animate = () => {
                    const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
                    const eased =
                      progress < 0.5
                        ? 2 * progress * progress
                        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                    const offset = startOffset + distance * eased;
                    scrollOffsetRef.current = offset;
                    scroll.scrollTo({ y: offset, animated: false });
                    if (progress < 1) {
                      oracleScrollTimerRef.current = setTimeout(animate, 16);
                    } else {
                      oracleScrollTimerRef.current = null;
                      finish();
                    }
                  };
                  animate();
                } else if (attempt < 8) {
                  oracleScrollTimerRef.current = setTimeout(measure, 120);
                } else {
                  finish();
                }
              },
            );
          });
        };
        measure();
      }, 140);
    });
  }, []);

  // shortReadingComplete becomes true the instant the card-flip animation
  // finishes (set inside finishDrawWithReading, right after the reveal
  // promise resolves). That is the correct moment to start the 2.5 s pause
  // so the user can see the three revealed cards before we scroll to the Oracle.
  // We also use this window to warm up the detailed-reading TTS so it is
  // already cached when the user taps unlock.
  const quickScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!shortReadingComplete) return;
    if (quickScrollTimerRef.current) clearTimeout(quickScrollTimerRef.current);
    if (stagedLongReading?.trim()) {
      void prefetchTts(stagedLongReading.trim()).catch(() => undefined);
    }
    quickScrollTimerRef.current = setTimeout(() => {
      quickScrollTimerRef.current = null;
      void scrollToOracle();
    }, 2500);
    return () => {
      if (quickScrollTimerRef.current) {
        clearTimeout(quickScrollTimerRef.current);
        quickScrollTimerRef.current = null;
      }
    };
  }, [shortReadingComplete, scrollToOracle, stagedLongReading]);

  const scrollToFollowUp = () => {
    setTimeout(() => {
      followUpSectionRef.current?.measureLayout(
        scrollViewRef.current as unknown as number,
        (_x, y, _width, _height) => {
          scrollViewRef.current?.scrollTo({ y: y - 60, animated: true });
        },
        () => {},
      );
    }, 150);
  };

  // Gentle floating animation for the ORACLE title
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(logoFloatAnim, {
          toValue: 1,
          duration: 3000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(logoFloatAnim, {
          toValue: 0,
          duration: 3000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [logoFloatAnim]);

  // Scroll to cards after first draw so they sit under the balance pill and the reading is visible
  useEffect(() => {
    if (
      drawnCards &&
      !isLoading &&
      !shortReading?.trim() &&
      !scrollToTopTriggered.current
    ) {
      scrollToTopTriggered.current = true;
      scrollToCards();
    }
  }, [drawnCards, isLoading, scrollToCards, shortReading]);

  // Intense loading pulse on the cards while AI is thinking (detail, follow-up questions, follow-up detail)
  useEffect(() => {
    const isThinking = isDetailLoading || isFollowUpDetailLoading || isFollowUpQuestionsLoading;
    if (!isThinking) {
      detailPulseAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(detailPulseAnim, {
          toValue: 1,
          duration: 700,
          easing: Easing.out(Easing.back(1.5)),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(detailPulseAnim, {
          toValue: 0,
          duration: 700,
          easing: Easing.out(Easing.back(1.5)),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    const startTimer = setTimeout(() => loop.start(), 150);
    return () => {
      clearTimeout(startTimer);
      loop.stop();
      detailPulseAnim.setValue(0);
    };
  }, [isDetailLoading, isFollowUpDetailLoading, isFollowUpQuestionsLoading, detailPulseAnim]);

  useEffect(() => {
    if (resetKey !== prevResetKey.current) {
      prevResetKey.current = resetKey;
      handleReset();
    }
  }, [resetKey]);

  React.useEffect(() => {
    if (drawnCards && !isLoading && !isLongUnlocked) {
      Animated.timing(longReadingAnim, {
        toValue: 1,
        duration: 700,
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
  }, [drawnCards, isLoading, isLongUnlocked, longReadingAnim]);

  // Single-call full reading — flips the wave target from 2-3 calls per
  // reading to 1 actual LLM trip. The first call costs a round-trip
  // (cache-miss on the server); every replay for the same question+cards
  // is served from the in-memory LRU cache and arrives sub-second.
  const fullReadingMutation = useMutation<
    FullReadingResponse,
    Error,
    { question: string; cards: any[] }
  >({
    mutationFn: async (vars) => {
      let firstTtsChunk = '';
      let earlyRevealRequested = false;
      return streamFullReading(vars, {
        // Wait until enough complete phrases are available to make a useful
        // first audio block. A lone 60-character sentence would create an
        // avoidable pause and an extra request.
        onShortReading: (value, complete) => {
          const completeSentences =
            value.match(/[^.!?…]+[.!?…]+(?:\s+|$)/g)?.map((part) => part.trim()) ?? [];
          const stableChunk = completeSentences.join(' ').trim();
          if (
            stableChunk &&
            (stableChunk.length >= 180 || complete) &&
            stableChunk !== firstTtsChunk
          ) {
            firstTtsChunk = stableChunk;
            if (!earlyRevealRequested) {
              earlyRevealRequested = true;
              setDrawRevealRequested(true);
            }
            void prefetchTts(stableChunk);
          }
          if (complete && value.trim()) {
            void prefetchTts(value);
          }
        },
      });
    },
    onSuccess: async (data) => {
      const snapshot = fullReadingMutation.variables;
      // Keep the final text as a safety-net warmup, but do not block the
      // visual reveal on its promise. The first stable block has already been
      // warming in parallel since the stream started.
      if (data.shortReading.trim()) {
        void prefetchTts(data.shortReading);
      }
      await finishDrawWithReading({
        short: data.shortReading,
        detailed: data.longReading,
        adviceText: data.advice,
        next: data.nextSteps,
        suggested: data.suggestedQuestions ?? [],
      });
      // STAGE the long-form content here — it's already paid-for in
      // the single LLM trip. handleUnlock() flips `isLongUnlocked` so
      // the UI reveals the staged content without paying another RPD.
      // Keeping the staging in separate setters prevents the locked
      // ReadingSection teaser from leaking the unlocked body.
      recordUsageEvent({
        question: snapshot?.question ?? question.trim(),
        responseType: 'full',
        creditsUsed: data.creditsUsed || 25,
        generationTimeMs: data.generationTimeMs || 0,
      }).catch(() => {});

    },
    onError: (error) => {
      refund(shortCost, 'Remboursement réponse rapide').catch(() => {});

      const status =
        (error as { status?: number })?.status ??
        (error as { response?: { status?: number } })?.response?.status;
      const message =
        status === 429 || error?.message?.includes('429')
          ? "L'IA n'a pas pu répondre : crédits Gemini épuisés ou quota dépassé. Vérifiez votre compte Google AI Studio."
          : "L'IA n'a pas pu répondre. Vérifiez votre connexion et réessayez.";
      setReadingError(message);
      setShortReading(null);
      setStagedLongReading(null);
      setStagedAdvice(null);
      setStagedNextSteps(null);
      setStagedSuggestedQuestions([]);
      setLongReading(null);
      setAdvice(null);
      setNextSteps(null);
      setIsLoading(false);
      cardFlipAnims.forEach((anim) => anim.setValue(1));
      Animated.timing(readingAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    },
  });

  const detailMutation = useCreateTarotReadingDetail({
    mutation: {
      onSuccess: (data) => {
        setDetailError(null);
        setLongReading(data.longReading);
        setAdvice(data.advice);
        setNextSteps(data.nextSteps);
        setIsDetailLoading(false);
        scrollToCards();

        recordUsageEvent({
          question: question.trim(),
          responseType: 'detail',
          creditsUsed: data.creditsUsed ?? detailCost,
          generationTimeMs: data.generationTimeMs ?? 0,
        }).catch(() => {});

        cardUnlockAnims.forEach((a) => a.setValue(0));
        Animated.timing(longReadingAnim, {
          toValue: 1,
          duration: 700,
          useNativeDriver: Platform.OS !== 'web',
        }).start(() => {
          Animated.timing(adviceAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: Platform.OS !== 'web',
          }).start(() => {
            handleGenerateFollowUpQuestions({
              skipSpend: true,
              silent: true,
              context: {
                shortReading: shortReading!,
                longReading: data.longReading,
                advice: data.advice,
                nextSteps: data.nextSteps,
              },
            });
          });
        });
      },
      onError: (error) => {
        // Le déblocage a échoué : rembourser les crédits débités avant l'appel.
        refund(detailCost, 'Remboursement réponse détaillée').catch(() => {});

        const status =
          (error as { status?: number })?.status ??
          (error as { response?: { status?: number } })?.response?.status;
        const message =
          status === 429 || error?.message?.includes('429')
            ? "L'IA n'a pas pu répondre : crédits Gemini épuisés ou quota dépassé. Vérifiez votre compte Google AI Studio."
            : "L'IA n'a pas pu répondre. Vérifiez votre connexion et réessayez.";
        setDetailError(message);
        setLongReading(null);
        setAdvice(null);
        setNextSteps(null);
        setIsDetailLoading(false);
        setIsLongUnlocked(false);
        longReadingAnim.setValue(1);
        animateCardUnlock(0);
      },
    },
  });

  const followUpQuestionsMutation = useCreateTarotFollowUpQuestions({
    mutation: {
      onSuccess: (data) => {
        setFollowUpError(null);
        setFollowUpQuestions(data.questions ?? []);
        setFollowUpQuestionsGenerated(true);
        setIsFollowUpQuestionsLoading(false);

        recordUsageEvent({
          question: question.trim(),
          responseType: 'follow_up_questions',
          creditsUsed: data.creditsUsed ?? followUpQuestionsCost,
          generationTimeMs: data.generationTimeMs ?? 0,
        }).catch(() => {});

        Animated.timing(followUpQuestionsAnim, {
          toValue: 1,
          duration: 650,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      },
      onError: (error) => {
        refund(followUpQuestionsCost, 'Remboursement questions de suivi').catch(() => {});
        setFollowUpError(
          (error as { message?: string })?.message ?? "Impossible de générer les questions de suivi.",
        );
        setIsFollowUpQuestionsLoading(false);
      },
    },
  });

  const followUpDetailMutation = useCreateTarotFollowUpDetail({
    mutation: {
      onSuccess: (data) => {
        setFollowUpError(null);
        const newContext = {
          shortReading: followUpContext?.shortReading ?? shortReading!,
          longReading: data.longReading,
          advice: data.advice,
          nextSteps: data.nextSteps,
        };
        setFollowUpDetail({
          longReading: data.longReading,
          advice: data.advice,
          nextSteps: data.nextSteps,
        });
        setFollowUpContext(newContext);
        setIsFollowUpDetailLoading(false);
        // Bring the newly positioned 'bottom' cards slot to the top of the screen
        // so the user sees cards → follow-up response just below.
        scrollToCards();

        recordUsageEvent({
          question: question.trim(),
          responseType: 'follow_up_detail',
          creditsUsed: data.creditsUsed ?? followUpDetailCost,
          generationTimeMs: data.generationTimeMs ?? 0,
        }).catch(() => {});

        Animated.timing(followUpDetailAnim, {
          toValue: 1,
          duration: 650,
          useNativeDriver: Platform.OS !== 'web',
        }).start(() => {
          handleGenerateFollowUpQuestions({ skipSpend: true, silent: true, context: newContext });
        });
      },
      onError: (error) => {
        refund(followUpDetailCost, 'Remboursement réponse de suivi').catch(() => {});
        setFollowUpError(
          (error as { message?: string })?.message ?? "Impossible d'obtenir une réponse détaillée.",
        );
        setIsFollowUpDetailLoading(false);
      },
    },
  });

  const handleReset = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    drawRevealResolverRef.current?.();
    drawRevealResolverRef.current = null;
    drawRevealCompletedRef.current = false;
    scrollToTopTriggered.current = false;
    setQuestion('');
    setDrawnCards(null);
    setShortReading(null);
    setShortReadingComplete(false);
    setLongReading(null);
    setAdvice(null);
    setNextSteps(null);
    setReadingError(null);
    setDetailError(null);
    setIsLongUnlocked(false);
    setIsLoading(false);
    setIsDetailLoading(false);
    setIsDetailTtsPrepared(false);
    setDrawRevealRequested(false);

    cardFlipAnims.forEach((a) => a.setValue(0));
    cardUnlockAnims.forEach((a) => a.setValue(0));
    readingAnim.setValue(0);
    longReadingAnim.setValue(0);
    adviceAnim.setValue(0);
    followUpQuestionsAnim.setValue(0);
    followUpDetailAnim.setValue(0);
    setFollowUpQuestions(null);
    setFollowUpDetail(null);
    setFollowUpError(null);
    setCustomFollowUpQuestion('');
    setIsCustomFollowUpVisible(false);
    setFollowUpDetailFor(null);
    setFollowUpQuestionsGenerated(false);
  };

  const buildContext = () => {
    if (followUpContext) return followUpContext;
    if (!shortReading || !longReading || !advice || !nextSteps) return null;
    return { shortReading, longReading, advice, nextSteps };
  };

  const handleGenerateFollowUpQuestions = async (options?: {
    skipSpend?: boolean;
    context?: TarotReadingContext;
    silent?: boolean;
    /**
     * Pre-built follow-up questions to render immediately, bypassing the
     * /tarot/reading/follow-up-questions LLM call. The single-call full
     * reading already returns these alongside short/long/advice/nextSteps,
     * so we re-use them here to avoid paying a second roundtrip.
     */
    prebuiltSuggestions?: string[];
  }) => {
    if (!isLongUnlocked || isFollowUpQuestionsLoading) return;
    const ctx = options?.context ?? buildContext();
    if (!ctx) return;
    const silent = !!options?.silent;
    if (!silent && !options?.skipSpend && !canAskFollowUpQuestions) return;
    if (!silent && !options?.skipSpend) {
      const spent = await spendFollowUpQuestions();
      if (!spent) return;
    }

    // Pre-built path: the full-reading wave pre-fetched suggestions, so
    // we just stamp them into state without paying another LLM trip.
    if (
      Array.isArray(options?.prebuiltSuggestions) &&
      options!.prebuiltSuggestions!.length > 0
    ) {
      setFollowUpError(null);
      setFollowUpQuestions(options.prebuiltSuggestions);
      setFollowUpQuestionsGenerated(true);
      setFollowUpContext(ctx);
      if (!silent) {
        followUpQuestionsAnim.setValue(0);
        Animated.timing(followUpQuestionsAnim, {
          toValue: 1,
          duration: 650,
          useNativeDriver: Platform.OS !== 'web',
        }).start();
      }
      return;
    }
    setFollowUpError(null);
    setFollowUpQuestions(null);
    setFollowUpQuestionsGenerated(false);
    if (!silent) {
      setIsFollowUpQuestionsLoading(true);
      followUpQuestionsAnim.setValue(0);
      scrollToCards();
    }
    if (isMockMode) {
      setTimeout(() => {
        setFollowUpQuestions([
          `Concrètement, quel aspect de "${question.trim().slice(0, 28)}…" dois-je traiter en priorité ?`,
          "Quel obstacle précis identifié par les cartes dois-je surveiller cette semaine ?",
          "Quel premier pas concret changerait vraiment la situation dès demain ?",
        ]);
        setFollowUpQuestionsGenerated(true);
        setIsFollowUpQuestionsLoading(false);
        recordUsageEvent({
          question: question.trim(),
          responseType: 'follow_up_questions',
          creditsUsed: 25,
          generationTimeMs: 500,
        }).catch(() => {});
        if (!silent) {
          Animated.timing(followUpQuestionsAnim, {
            toValue: 1,
            duration: 650,
            useNativeDriver: Platform.OS !== 'web',
          }).start();
        }
      }, 500);
      return;
    }
    followUpQuestionsMutation.mutate({
      data: {
        question: question.trim(),
        cards: drawnCards!.map((c) => ({
          name: c.name,
          theme: c.theme,
          upright: c.upright,
          reversed: c.reversed,
          position: c.position,
          isReversed: c.isReversed,
        })),
        context: ctx,
      },
    });
  };

  const handleAskFollowUpQuestion = async (followUpQuestion: string, isSuggested = false) => {
    if (!isLongUnlocked || isFollowUpDetailLoading) return;
    const ctx = buildContext();
    if (!ctx) return;
    const cost = isSuggested ? followUpSuggestedDetailCost : followUpDetailCost;
    const canAsk = isSuggested ? canAskFollowUpSuggestedDetail : canAskFollowUpDetail;
    const spend = isSuggested ? spendFollowUpSuggestedDetail : spendFollowUpDetail;
    if (!canAsk) {
      Alert.alert(
        'Crédits insuffisants',
        `Vous avez besoin de ${cost} crédits pour cette réponse de suivi. Allez à la Boutique pour recharger votre solde.`,
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Boutique', onPress: () => router.push('/boutique') },
        ],
      );
      return;
    }
    const spent = await spend();
    if (!spent) return;
    const trimmed = followUpQuestion.trim();
    setFollowUpError(null);
    setIsFollowUpDetailLoading(true);
    setFollowUpDetail(null);
    setFollowUpDetailFor(trimmed);
    followUpDetailAnim.setValue(0);
    Keyboard.dismiss();
    scrollToCards();
    if (isMockMode) {
      setTimeout(() => {
        const newContext = {
          shortReading: followUpContext?.shortReading ?? shortReading!,
          longReading: `Votre question de suivi « ${trimmed} » met en lumière ${drawnCards?.[0]?.name ?? 'la première carte'} et ${drawnCards?.[1]?.name ?? 'la deuxième carte'} comme points d'appui.`,
          advice: `Concentrez-vous sur ${drawnCards?.[1]?.name ?? 'la carte centrale'} pour rester aligné avec votre intention.`,
          nextSteps: `Notez une action inspirée par ${drawnCards?.[2]?.name ?? 'la troisième carte'} et réalisez-la sous 48 heures.`,
        };
        setFollowUpDetail(newContext);
        setFollowUpContext(newContext);
        setFollowUpDetailFor(trimmed);
        setIsFollowUpDetailLoading(false);
        // Cards are now positioned at 'bottom' (between detail and follow-up response).
        // Scroll them to the top of the screen so the response sits just below them.
        scrollToCards();
        recordUsageEvent({
          question: question.trim(),
          responseType: 'follow_up_detail',
          creditsUsed: cost,
          generationTimeMs: 650,
        }).catch(() => {});
        Animated.timing(followUpDetailAnim, {
          toValue: 1,
          duration: 650,
          useNativeDriver: Platform.OS !== 'web',
        }).start(() => {
          handleGenerateFollowUpQuestions({ skipSpend: true, silent: true, context: newContext });
        });
      }, 650);
      return;
    }
    followUpDetailMutation.mutate({
      data: {
        question: question.trim(),
        cards: drawnCards!.map((c) => ({
          name: c.name,
          theme: c.theme,
          upright: c.upright,
          reversed: c.reversed,
          position: c.position,
          isReversed: c.isReversed,
        })),
        context: ctx,
        followUpQuestion: trimmed,
        isSuggested,
      },
    });
  };

  const animateCardUnlock = (toValue: number, onComplete?: () => void) => {
    Animated.stagger(
      90,
      cardUnlockAnims.map((anim) =>
        Animated.timing(anim, {
          toValue,
          duration: 900,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ),
    ).start(onComplete);
  };

  const handleDraw = async () => {
    if (!question.trim()) {
      Alert.alert('Posez votre question', 'Écrivez une question pour que les cartes puissent guider.');
      return;
    }

    if (!canReadShort) {
      Alert.alert(
        'Crédits insuffisants',
        `Vous avez besoin de ${shortCost} crédits pour une réponse rapide. Allez à la Boutique pour recharger votre solde.`,
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Boutique', onPress: () => router.push('/boutique') },
        ],
      );
      return;
    }

    // Débiter les crédits avant de lancer la génération. Remboursement en cas d'échec IA.
    const spent = await spendShort();
    if (!spent) {
      Alert.alert('Crédits insuffisants', 'Votre solde est trop faible pour effectuer ce tirage.');
      return;
    }

    // A new draw must never overlap audio from the previous reading.
    await stopTts();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Keyboard.dismiss();

    // Reset state
    setShortReading(null);
    setLongReading(null);
    setAdvice(null);
    setNextSteps(null);
    setReadingError(null);
    setDetailError(null);
    setIsLongUnlocked(false);
    setIsLoading(true);
    setIsDetailLoading(false);
    setIsDetailTtsPrepared(false);
    detailTtsPrepRunRef.current += 1;
    setDrawRevealRequested(false);
    drawRevealCompletedRef.current = false;
    drawRevealResolverRef.current?.();
    drawRevealResolverRef.current = null;

    // Reset animations
    cardFlipAnims.forEach((a) => a.setValue(0));
    cardUnlockAnims.forEach((a) => a.setValue(0));
    readingAnim.setValue(0);
    longReadingAnim.setValue(0);
    adviceAnim.setValue(0);

    const cards = drawThreeCards();
    setDrawnCards(cards);

    if (isMockMode) {
      const mockReading = generateMockReadings(cards, question.trim());
      await finishDrawWithReading({
        short: mockReading.shortReading,
        detailed: mockReading.longReading,
        adviceText: mockReading.advice,
        next: mockReading.nextSteps,
        suggested: [],
      });

      recordUsageEvent({
        question: question.trim(),
        responseType: 'short',
        creditsUsed: shortCost,
        generationTimeMs: 0,
      }).catch(() => {});
      return;
    }

    // Generate the short response and stage the paid detail from the same
    // server response. Keeping one request prevents two responses racing to
    // overwrite the visible short reading.
    fullReadingMutation.mutate({
      question: question.trim(),
      cards: cards.map((c) => ({
        name: c.name,
        theme: c.theme,
        upright: c.upright,
        reversed: c.reversed,
        position: c.position,
        isReversed: c.isReversed,
      })),
    });
  };

  const revealDetailedReading = async (
    reading: string,
    adviceText: string,
    nextText: string,
    suggestedQuestions: string[],
    minimumAnimationMs = 0,
  ) => {
    const prepRun = detailTtsPrepRunRef.current;
    const trimmedReading = reading.trim();
    if (!trimmedReading) return;

    const ttsPreparation = prefetchTts(trimmedReading).catch(() => undefined);
    const maxWait = new Promise<void>((resolve) => {
      setTimeout(resolve, DETAIL_TTS_PREP_TIMEOUT_MS);
    });
    const minimumAnimation = new Promise<void>((resolve) => {
      setTimeout(resolve, minimumAnimationMs);
    });

    // The first TTS chunk is enough to reveal the detailed Oracle. If a cold
    // Gemini request is slower than the patience window, the warmup continues
    // in the background and speakText() will consume it when autoplay starts.
    await Promise.all([Promise.race([ttsPreparation, maxWait]), minimumAnimation]);
    if (prepRun !== detailTtsPrepRunRef.current) return;

    setLongReading(trimmedReading);
    setAdvice(adviceText);
    setNextSteps(nextText);
    setIsDetailTtsPrepared(true);
    setIsDetailLoading(false);
    longReadingAnim.setValue(0);
    adviceAnim.setValue(0);
    scrollToCards();

    cardUnlockAnims.forEach((a) => a.setValue(0));
    Animated.timing(longReadingAnim, {
      toValue: 1,
      duration: 700,
      useNativeDriver: Platform.OS !== 'web',
    }).start(() => {
      Animated.timing(adviceAnim, {
        toValue: 1,
        duration: 600,
        useNativeDriver: Platform.OS !== 'web',
      }).start(() => {
        if (suggestedQuestions.length > 0) {
          handleGenerateFollowUpQuestions({
            skipSpend: true,
            silent: true,
            context: {
              shortReading: shortReading ?? '',
              longReading: trimmedReading,
              advice: adviceText,
              nextSteps: nextText,
            },
            prebuiltSuggestions: suggestedQuestions,
          });
        }
      });
    });
  };

  const handleUnlock = async () => {
    if (!drawnCards || detailMutation.isPending) return;

    if (!canReadDetail) {
      Alert.alert(
        'Crédits insuffisants',
        `Vous avez besoin de ${detailCost} crédits supplémentaires pour débloquer la lecture détaillée. Allez à la Boutique pour recharger votre solde.`,
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Boutique', onPress: () => router.push('/boutique') },
        ],
      );
      return;
    }

    // Débiter les crédits avant de lancer la génération. Remboursement en cas d'échec IA.
    const spent = await spendDetail();
    if (!spent) {
      Alert.alert('Crédits insuffisants', 'Votre solde est trop faible pour débloquer la lecture détaillée.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setDetailError(null);
    setIsLongUnlocked(true);
    setIsDetailLoading(true);
    setIsDetailTtsPrepared(false);
    detailTtsPrepRunRef.current += 1;
    longReadingAnim.setValue(0);
    adviceAnim.setValue(0);
    scrollToCards();

    // Show Pulse Orbit animation while the AI thinks (cards are rendered in cardsSpread via isDetailLoading)

    if (isMockMode) {
      const { longReading, advice, nextSteps } = generateMockReadings(drawnCards, question.trim());
      void revealDetailedReading(longReading, advice, nextSteps, [], 800);
      recordUsageEvent({
        question: question.trim(),
        responseType: 'detail',
        creditsUsed: detailCost,
        generationTimeMs: 800,
      }).catch(() => {});
      return;
    }

    // Single-call architecture: the full reading content was already
    // staged during handleDraw by fullReadingMutation. We just need to
    // reveal it. No second server round-trip, no second LLM call.
    setDetailError(null);
    scrollToCards();

    // Reveal changes the content height. Measure after layout so the fixed
    // cards sit at the top of the viewport and the detailed answer follows.
    setTimeout(() => scrollToCards(), 180);

    recordUsageEvent({
      question: question.trim(),
      responseType: 'detail',
      creditsUsed: detailCost,
      generationTimeMs: 0,
    }).catch(() => {});

    if (stagedLongReading) {
      void revealDetailedReading(
        stagedLongReading,
        stagedAdvice ?? '',
        stagedNextSteps ?? '',
        stagedSuggestedQuestions,
      );
    }
  };

  const canDraw =
    visualAssetsReady &&
    question.trim().length > 0 &&
    !isLoading &&
    !isDetailLoading;

  const { width: screenWidth } = useWindowDimensions();

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  // The tab navigator already accounts for its own bar height. Only reserve
  // the native home-indicator inset here; adding the tab height again leaves
  // the final Oracle content visibly stranded above the Options tab.
  const tabBarContentHeight = 46;
  // The tab bar is intentionally overlaid so the main Oracle frame can use
  // the full viewport. Reserve exactly the overlay height here—no extra
  // frame-sized margin—so the final image ends at the tab bar edge.
  const bottomPad =
    Platform.OS === 'web'
      ? 34
      : tabBarContentHeight + insets.bottom + 24;

  // Responsive sizing for the logo and tarot cards
  const logoFontSize = clamp(screenWidth * 0.10, 32, 50);
  const cardWidth = clamp((screenWidth - 32) / 3, 95, 200);
  const cardHeight = cardWidth * (240 / 150);
  // The revealed cards carry their labels inside the artwork, so the spread
  // no longer needs a full extra plaque row underneath.
  const cardsSpreadHeight = cardHeight * 1.02;

  // Cards sit in 3 different positions depending on the reading state:
  //  - 'top': only short reading exists → cards between draw button and short answer.
  //  - 'middle': long reading exists, no follow-up answer yet → cards between short and detail.
  //  - 'bottom': long reading AND a follow-up answer exist → cards between detail and follow-up response.
  // During loading, scrollToCards() brings the active cards slot to the top of the screen
  // so the Pulse Orbit stays visible while the AI thinks.
  const showCardsAt: 'top' | 'middle' | 'bottom' = !longReading
    ? 'top'
    : !followUpDetail
    ? 'middle'
    : 'bottom';

  const renderCardsSpread = (position: 'top' | 'middle' | 'bottom') => (
    <View
      key={`cards-spread-${position}`}
      ref={cardsSpreadRef}
      style={[
        styles.cardsSpread,
        {
          height: isLoading
            ? cardHeight * 2.45
            : isDetailLoading
              ? cardHeight * 1.65
              : cardsSpreadHeight,
          marginTop: position === 'top' ? 8 : 10,
          marginBottom: 4,
        },
      ]}
    >
      {drawnCards && isLoading ? (
        <LongOrbitCards
          cards={drawnCards}
          cardWidth={cardWidth}
          cardHeight={cardHeight}
          revealRequested={drawRevealRequested}
          onRevealComplete={handleDrawRevealComplete}
        />
      ) : drawnCards && (isDetailLoading || isFollowUpDetailLoading || isFollowUpQuestionsLoading) ? (
        <PulseOrbitCards
          cards={drawnCards}
          cardWidth={cardWidth}
          cardHeight={cardHeight}
          large={isDetailLoading}
        />
      ) : drawnCards ? (
        drawnCards.map((card, i) => (
          <CardView
            key={`${card.id}-${i}`}
            card={card}
            flipAnim={cardFlipAnims[i]}
            index={i}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            finalRow={Boolean(shortReading && !isLoading)}
          />
        ))
      ) : (
        Array.from({ length: 3 }).map((_, i) => (
          <CardBack
            key={`back-${i}`}
            index={i}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
          />
        ))
      )}
    </View>
  );
  const detailedOracleReady =
    isLongUnlocked &&
    isDetailTtsPrepared &&
    !isDetailLoading &&
    Boolean(longReading?.trim());

  return (
    <ImageBackground
      source={TAROT_BG}
      style={styles.container}
      resizeMode="cover"
    >
      <VisualAssetPreloader />
      {/* Dark overlay */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10, 8, 21, 0.55)' }]} />

      {!visualAssetsReady ? (
        <View style={styles.assetLoadingBadge} pointerEvents="none">
          <ActivityIndicator size="small" color="#C9A84C" />
          <Text style={styles.assetLoadingText}>Préparation de l’oracle…</Text>
        </View>
      ) : null}

      {/* Shooting stars */}
      <ShootingStars />

      {/* Header */}
      <View
        style={[styles.header, { paddingTop: topPad + 2 }]}
      >
        <Pressable
          onPress={handleLogoPress}
          onLongPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            setIsMockMode((prev) => !prev);
          }}
          delayLongPress={600}
        >
          <Animated.Text
            style={[
              styles.logoText,
              {
                fontSize: logoFontSize,
                letterSpacing: logoFontSize * 0.22,
                color: colors.primary,
                textShadowColor: hexToRgba(colors.primary, 0.55),
                textShadowOffset: { width: 0, height: 0 },
                textShadowRadius: logoFontSize * 0.45,
                transform: [
                  {
                    translateY: logoFloatAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -5],
                    }),
                  },
                ],
              },
            ]}
          >
            ORACLE
          </Animated.Text>
        </Pressable>
        <View style={[styles.divider, { backgroundColor: hexToRgba(colors.primary, 0.5) }]} />

        {/* Balance pill */}
        <View
          style={[
            styles.balancePill,
            { backgroundColor: 'rgba(28, 24, 69, 0.72)', borderColor: hexToRgba(colors.primary, 0.35) },
          ]}
        >
          <Feather name="zap" size={14} color={colors.primary} />
          <AnimatedBalance balance={balance} style={[styles.balancePillText, { color: colors.foreground }]} />
        </View>

        {isMockMode && (
          <View style={[styles.mockBadge, { borderColor: colors.accent }]}>
            <Text style={[styles.mockBadgeText, { color: colors.accent }]}>MODE DÉMO</Text>
          </View>
        )}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View ref={scrollViewportRef} style={{ flex: 1 }}>
          <ScrollView
            ref={scrollViewRef}
            style={{ flex: 1 }}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: bottomPad },
            ]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => {
              scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
          >
        {/* Question */}
        <View style={[styles.section, { marginTop: 8 }]}>
          <View style={styles.questionLabelRow}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              VOTRE QUESTION
            </Text>
            <Pressable
              onPress={
                showQuestionHint
                  ? dismissQuestionHint
                  : showQuestionHintWithAnimation
              }
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Pourquoi détailler votre question ?"
              accessibilityState={{ expanded: showQuestionHint }}
            >
              <Feather name="help-circle" size={15} color={colors.primary} />
            </Pressable>
          </View>
          {showQuestionHint ? (
            <Animated.View
              style={[
                {
                  opacity: questionHintEntrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 1],
                  }),
                  transform: [
                    {
                      translateY: questionHintEntrance.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-4, 0],
                      }),
                    },
                    {
                      scale: questionHintEntrance.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.98, 1],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Animated.View
                style={[
                  styles.questionHint,
                  {
                    opacity: questionHintDisperse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 0],
                    }),
                    transform: [
                      {
                        translateY: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, -5],
                        }),
                      },
                      {
                        scale: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 1.045],
                        }),
                      },
                    ],
                  },
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.78)',
                  borderColor: hexToRgba(colors.primary, 0.28),
                },
              ]}
            >
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.questionHintFragment,
                  styles.questionHintFragmentA,
                  {
                    backgroundColor: colors.primary,
                    opacity: questionHintDisperse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 0.9],
                    }),
                    transform: [
                      {
                        translateX: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, -8],
                        }),
                      },
                      {
                        translateY: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, -7],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.questionHintFragment,
                  styles.questionHintFragmentB,
                  {
                    backgroundColor: colors.accent,
                    opacity: questionHintDisperse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 0.85],
                    }),
                    transform: [
                      {
                        translateX: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, 9],
                        }),
                      },
                      {
                        translateY: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, -5],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.questionHintFragment,
                  styles.questionHintFragmentC,
                  {
                    backgroundColor: colors.primary,
                    opacity: questionHintDisperse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 0.75],
                    }),
                    transform: [
                      {
                        translateX: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, 5],
                        }),
                      },
                      {
                        translateY: questionHintDisperse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, 8],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <Feather name="info" size={13} color={colors.primary} />
              <Text style={[styles.questionHintText, { color: colors.mutedForeground }]}>
                Plus votre question est précise et détaillée, plus l’Oracle pourra vous répondre
                avec justesse.
              </Text>
            </Animated.View>
            </Animated.View>
          ) : null}
          <TextInput
            style={[
              styles.questionInput,
              {
                backgroundColor: 'rgba(28, 24, 69, 0.6)',
                borderColor: colors.border,
                color: colors.foreground,
              },
            ]}
            placeholder="Quelle est votre question ?"
            placeholderTextColor={colors.mutedForeground}
            value={question}
            onChangeText={setQuestion}
            multiline
            maxLength={150}
            textAlignVertical="top"
          />
          <Text style={[styles.charCount, { color: colors.mutedForeground }]}>
            {question.length}/150
          </Text>
        </View>

        {/* Draw Button */}
        <Pressable
          style={({ pressed }) => [
            styles.drawButton,
            {
              backgroundColor: canDraw ? (pressed ? '#B89A42' : colors.primary) : colors.muted,
              opacity: canDraw ? 1 : 0.5,
            },
            shadowStyle({
              color: canDraw ? colors.primary : 'transparent',
              offset: { width: 0, height: 6 },
              opacity: 0.28,
              radius: 16,
              elevation: 8,
            }),
          ]}
          onPress={handleDraw}
          disabled={!canDraw}
        >
          {isLoading ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={[styles.drawButtonText, { color: colors.primaryForeground }]}>
              TIRER LES CARTES — {shortCost} CRÉDITS
            </Text>
          )}
        </Pressable>

        {/* Cards spread - rendered at the position that matches the current reading state */}
        {showCardsAt === 'top' && renderCardsSpread('top')}

        {/* Short Reading */}
        {(shortReading || isLoading) && drawnCards && !detailedOracleReady && (
        <ReadingSection
            title="RÉPONSE RAPIDE"
            text={shortReading ?? ''}
            highlightWords={drawnCards.map((c) => c.name)}
            isLoading={isLoading}
            fadeAnim={readingAnim}
            variant="gold"
            audioText={shortReading ?? undefined}
             showSpeakingOracle={Boolean(shortReading?.trim())}
            autoPlayEnabled={shortReadingComplete}
             oracleAnchorRef={oracleSectionRef}
        />
        )}

        {/* Error state */}
        {readingError && drawnCards && !isLoading && (
          <Animated.View
            style={[
              styles.errorBox,
              {
                backgroundColor: 'rgba(28, 24, 69, 0.72)',
                borderColor: 'rgba(200, 100, 80, 0.4)',
                opacity: readingAnim,
              },
            ]}
          >
            <Feather name="alert-circle" size={20} color="#E88A70" />
            <View style={styles.errorTextWrapper}>
              <Text style={[styles.errorText, { color: colors.foreground }]}>{readingError}</Text>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  handleDraw();
                }}
                style={styles.retryLink}
              >
                <Text style={[styles.retryLinkText, { color: colors.primary }]}>
                  Réessayer le tirage
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        )}

        {/* Cards spread - 'middle' position when long reading exists but no follow-up yet */}
        {showCardsAt === 'middle' && renderCardsSpread('middle')}

        {/* Long Reading */}
        {drawnCards && !isLoading && (
          <ReadingSection
            title="LECTURE DÉTAILLÉE"
            text={
              longReading ??
              "Une réponse brève vous a été offerte. La lecture complète révèle pourquoi ces trois cartes répondent précisément à votre question, quel conseil unique elles portent et les premiers pas à suivre dès demain. Débloquez-la pour avancer sereinement."
            }
            highlightWords={drawnCards?.map((c) => c.name)}
            isLocked={!isLongUnlocked}
            onUnlock={handleUnlock}
            isLoading={isDetailLoading}
            fadeAnim={longReadingAnim}
            variant="gold"
            unlockCost={detailCost}
            audioText={longReading ?? undefined}
            prompterText={longReading ?? undefined}
            framedText={detailedOracleReady ? shortReading ?? undefined : undefined}
            showSpeakingOracle={detailedOracleReady}
            autoPlayEnabled={detailedOracleReady}
            onOracleReady={scrollToOracle}
            oracleAnchorRef={oracleSectionRef}
          />
        )}

        {/* Detail error */}
        {detailError && drawnCards && !isLoading && !isDetailLoading && (
          <Animated.View
            style={[
              styles.errorBox,
              {
                backgroundColor: 'rgba(28, 24, 69, 0.72)',
                borderColor: 'rgba(200, 100, 80, 0.4)',
                opacity: longReadingAnim,
              },
            ]}
          >
            <Feather name="alert-circle" size={20} color="#E88A70" />
            <View style={styles.errorTextWrapper}>
              <Text style={[styles.errorText, { color: colors.foreground }]}>{detailError}</Text>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  handleUnlock();
                }}
                style={styles.retryLink}
              >
                <Text style={[styles.retryLinkText, { color: colors.primary }]}>
                  Réessayer le déblocage
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        )}

        {/* Advice & Next Steps */}
        {isLongUnlocked && advice && nextSteps && (
          <>
            <Animated.View
              style={[
                styles.miniSection,
                {
                  backgroundColor: 'rgba(139, 124, 200, 0.14)',
                  borderColor: hexToRgba(colors.accent, 0.35),
                  opacity: adviceAnim,
                  transform: [
                    {
                      translateY: adviceAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [18, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={styles.miniHeaderRow}>
                <View style={styles.miniHeader}>
                  <Feather name="compass" size={14} color={colors.accent} />
                  <Text style={[styles.miniTitle, { color: colors.accent }]}>Conseil</Text>
                </View>
                {advice ? (
                  <AudioButton text={advice} accent={colors.accent} compact />
                ) : null}
              </View>
              <HighlightedText
                text={advice}
                highlightWords={drawnCards?.map((c) => c.name)}
                baseStyle={[styles.miniText, { color: colors.foreground }]}
                highlightStyle={[styles.miniText, { color: colors.accent, fontWeight: '700' as const }]}
              />
            </Animated.View>

            <Animated.View
              style={[
                styles.miniSection,
                {
                  backgroundColor: 'rgba(201, 168, 76, 0.12)',
                  borderColor: hexToRgba(colors.primary, 0.35),
                  opacity: adviceAnim,
                  transform: [
                    {
                      translateY: adviceAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [18, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={styles.miniHeaderRow}>
                <View style={styles.miniHeader}>
                  <Feather name="arrow-right-circle" size={14} color={colors.primary} />
                  <Text style={[styles.miniTitle, { color: colors.primary }]}>Que faire maintenant</Text>
                </View>
                {nextSteps ? (
                  <AudioButton text={nextSteps} accent={colors.primary} compact />
                ) : null}
              </View>
              <HighlightedText
                text={nextSteps}
                highlightWords={drawnCards?.map((c) => c.name)}
                baseStyle={[styles.miniText, { color: colors.foreground }]}
                highlightStyle={[styles.miniText, { color: colors.primary, fontWeight: '700' as const }]}
              />
            </Animated.View>
          </>
        )}

        {isLongUnlocked && longReading && advice && nextSteps && !isDetailLoading && (
          <Animated.View
            ref={followUpSectionRef}
            style={[
              styles.followUpActions,
              { opacity: followUpQuestionsAnim },
            ]}
          >
            {/* Cards spread - 'bottom' position when follow-up answer exists (drawn here so the
                Pulse Orbit plays between the long reading and the follow-up response). */}
            {showCardsAt === 'bottom' && renderCardsSpread('bottom')}

            {followUpDetail && (
              <Animated.View style={[styles.followUpResponseSection, { backgroundColor: 'rgba(24, 20, 52, 0.82)', borderColor: hexToRgba(colors.accent, 0.55), opacity: followUpDetailAnim }]}>
                <View style={styles.miniHeaderRow}>
                  <View style={[styles.followUpResponseHeader, { backgroundColor: hexToRgba(colors.accent, 0.18), borderColor: hexToRgba(colors.accent, 0.45) }]}>
                    <Feather name="star" size={14} color={colors.accent} />
                    <Text style={[styles.followUpResponseTitle, { color: colors.accent }]}>RÉPONSE DE SUIVI</Text>
                  </View>
                  {followUpDetail ? (
                    <AudioButton
                      text={[
                        followUpDetail.longReading,
                        followUpDetail.advice,
                        followUpDetail.nextSteps,
                      ]
                        .filter(Boolean)
                        .join('. ')}
                      accent={colors.accent}
                      compact
                    />
                  ) : null}
                </View>
                <View style={[styles.followUpResponseBlock, { borderColor: hexToRgba(colors.accent, 0.25) }]}>
                  <Text style={[styles.followUpResponseBlockTitle, { color: colors.accent }]}>Analyse</Text>
                  <HighlightedText text={followUpDetail.longReading} highlightWords={drawnCards?.map((c) => c.name)} baseStyle={[styles.readingText, { color: colors.foreground }]} highlightStyle={[styles.readingText, { color: colors.primary, fontWeight: '700' as const }]} />
                </View>
                <View style={[styles.followUpResponseBlock, { borderColor: hexToRgba(colors.accent, 0.25) }]}>
                  <Text style={[styles.followUpResponseBlockTitle, { color: colors.accent }]}>Conseil</Text>
                  <HighlightedText text={followUpDetail.advice} highlightWords={drawnCards?.map((c) => c.name)} baseStyle={[styles.miniText, { color: colors.foreground }]} highlightStyle={[styles.miniText, { color: colors.accent, fontWeight: '700' as const }]} />
                </View>
                <View style={[styles.followUpResponseBlock, { borderColor: hexToRgba(colors.primary, 0.25) }]}>
                  <Text style={[styles.followUpResponseBlockTitle, { color: colors.primary }]}>Que faire maintenant</Text>
                  <HighlightedText text={followUpDetail.nextSteps} highlightWords={drawnCards?.map((c) => c.name)} baseStyle={[styles.miniText, { color: colors.foreground }]} highlightStyle={[styles.miniText, { color: colors.primary, fontWeight: '700' as const }]} />
                </View>
                {followUpDetailFor && (
                  <Text style={[styles.followUpDetailFor, { color: colors.mutedForeground }]}>
                    Pour : {followUpDetailFor}
                  </Text>
                )}
              </Animated.View>
            )}
            {(isFollowUpQuestionsLoading || isFollowUpDetailLoading) && drawnCards && (
              <View style={styles.followUpLoadingCaption}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.followUpLoadingText, { color: colors.mutedForeground }]}>
                  L'oracle consulte les cartes…
                </Text>
              </View>
            )}
            {followUpQuestions && followUpQuestions.length > 0 ? (
              followUpQuestions.map((q, index) => (
                <Pressable
                  key={`${q}-${index}`}
                  style={styles.followUpButton}
                  onPress={() => handleAskFollowUpQuestion(q, true)}
                >
                  <Text style={styles.followUpButtonText} numberOfLines={2} ellipsizeMode="tail">
                    {q}
                  </Text>
                  <Text style={styles.followUpButtonPrice}>25 cr</Text>
                </Pressable>
              ))
            ) : (
              <>
                <Pressable style={styles.followUpButton} disabled>
                  <Text style={[styles.followUpButtonText, { opacity: 0.6 }]}>…</Text>
                </Pressable>
                <Pressable style={styles.followUpButton} disabled>
                  <Text style={[styles.followUpButtonText, { opacity: 0.6 }]}>…</Text>
                </Pressable>
                <Pressable style={styles.followUpButton} disabled>
                  <Text style={[styles.followUpButtonText, { opacity: 0.6 }]}>…</Text>
                </Pressable>
              </>
            )}
            {isCustomFollowUpVisible && (
              <TextInput
                ref={customInputRef}
                style={[
                  styles.followUpInput,
                  { backgroundColor: 'rgba(18, 15, 38, 0.8)', borderColor: colors.border, color: colors.foreground },
                ]}
                value={customFollowUpQuestion}
                onChangeText={setCustomFollowUpQuestion}
                placeholder="Votre question de suivi"
                placeholderTextColor={colors.mutedForeground}
                autoFocus={Platform.OS !== 'web'}
                onFocus={() => {
                  setTimeout(() => {
                    customInputRef.current?.measureLayout(
                      scrollViewRef.current as unknown as number,
                      (_x, y, _width, _height) => {
                        scrollViewRef.current?.scrollTo({ y: y - 120, animated: true });
                      },
                      () => {},
                    );
                  }, 100);
                }}
              />
            )}
            <Pressable
              style={styles.followUpButton}
              onPress={() => {
                if (!isCustomFollowUpVisible) {
                  setIsCustomFollowUpVisible(true);
                  return;
                }
                handleAskFollowUpQuestion(customFollowUpQuestion, false);
              }}
            >
              <Text style={styles.followUpButtonText}>QUESTION DE SUIVI — 30 cr</Text>
            </Pressable>
            <Pressable style={styles.followUpButton} onPress={handleReset}>
              <Text style={styles.followUpButtonText}>NOUVELLE QUESTION</Text>
            </Pressable>
            {isFollowUpQuestionsLoading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Génération des questions…</Text>
              </View>
            )}
            {followUpError && (
              <View style={styles.errorTextWrapper}>
                <Text style={[styles.errorText, { color: colors.foreground }]}>{followUpError}</Text>
                <Pressable onPress={() => handleGenerateFollowUpQuestions({ skipSpend: true })} style={styles.retryLink}>
                  <Text style={[styles.retryLinkText, { color: colors.primary }]}>Réessayer</Text>
                </Pressable>
              </View>
            )}
          </Animated.View>
        )}

          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </ImageBackground>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  assetPreloader: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0.01,
    left: -10,
    top: -10,
    overflow: 'hidden',
  },
  assetLoadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: '#100D20',
  },
  assetLoadingBadge: {
    position: 'absolute',
    top: 110,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(16, 13, 32, 0.78)',
    zIndex: 20,
  },
  assetLoadingText: {
    color: '#FFF7DF',
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  preloadedAsset: {
    width: 1,
    height: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    gap: 16,
  },

  // Shooting star
  shootingStarHead: {
    borderRadius: 999,
  },

  // Header
  header: {
    alignItems: 'center',
    gap: 6,
  },
  appTitle: {
    fontSize: 38,
    fontWeight: '700',
    letterSpacing: 12,
    fontFamily: 'Inter_700Bold',
  },
  logoText: {
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  divider: {
    height: 1,
    width: '45%',
  },
  balancePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 5,
  },
  balancePillText: {
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  mockBadge: {
    borderWidth: 1,
    borderRadius: 100,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  mockBadgeText: {
    fontSize: 9,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.5,
  },

  // Sections
  section: {
    gap: 10,
  },
  sectionLabel: {
    fontSize: 10,
    letterSpacing: 3,
    fontFamily: 'Inter_600SemiBold',
  },
  questionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  questionHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: 'relative',
    overflow: 'visible',
  },
  questionHintFragment: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  questionHintFragmentA: {
    left: 13,
    top: -2,
  },
  questionHintFragmentB: {
    right: 28,
    top: -3,
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },
  questionHintFragmentC: {
    right: 8,
    bottom: -2,
  },
  questionHintText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },

  // Question Input
  questionInput: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    minHeight: 96,
    fontFamily: 'Inter_400Regular',
    lineHeight: 22,
  },
  charCount: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    alignSelf: 'flex-end',
  },

  // Draw Button
  drawButton: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  drawButtonText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 3.5,
    fontFamily: 'Inter_700Bold',
  },

  // Cards spread
  cardsSpread: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 4,
  },
  cardStage: {
    position: 'relative',
    width: 150,
    height: 240,
    marginHorizontal: -4,
  },
  cardGlow: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    bottom: 6,
    borderRadius: 14,
  },
  cardSide: {
    ...StyleSheet.absoluteFill,
    borderRadius: 14,
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  cardImage: {
    width: '100%',
    height: '100%',
    borderRadius: 14,
  },
  cardImageReversed: {
    transform: [{ rotate: '180deg' }],
  },
  positionBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  positionBadgeCompact: {
    top: 7,
    left: 6,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  positionBadgeText: {
    fontSize: 8,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.5,
    color: '#0A0815',
  },
  positionBadgeTextCompact: {
    fontSize: 7,
    letterSpacing: 0.8,
  },
  orientationBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 100,
  },
  orientationBadgeCompact: {
    top: 31,
    left: 6,
    right: undefined,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  orientationText: {
    fontSize: 9,
    fontFamily: 'Inter_700Bold',
    color: '#fff',
  },
  orientationTextCompact: {
    fontSize: 8,
  },
  cardLabelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 45,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 5,
    backgroundColor: 'rgba(10, 8, 21, 0.58)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(225, 185, 111, 0.35)',
  },
  cardLabelName: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.3,
    textAlign: 'center',
    flexShrink: 1,
  },
  cardLabelTheme: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginTop: 2,
  },

  // Reading
  readingSection: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    gap: 10,
    overflow: 'hidden',
  },
  oracleBreakout: {
    marginHorizontal: -20,
    marginBottom: -20,
    marginTop: 4,
  },
  oracleStandalone: {
    width: '100%',
    flexShrink: 0,
    // The scroll content has a 16px global gap. Pull the Oracle image up so
    // its top edge nearly meets the bottom edge of the revealed cards.
    marginTop: -14,
    position: 'relative',
  },
  oracleFrame: {
    width: '100%',
    alignSelf: 'center',
  },
  quickReadingFrame: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    gap: 10,
    marginBottom: 12,
    overflow: 'hidden',
  },
  quickReadingFrameHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quickReadingFrameTitle: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2.4,
  },
  quickReadingFrameText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 21,
  },
  oracleReplayButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 5,
  },
  readingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  shootingStarIcon: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  starHead: {
    position: 'absolute',
  },
  starTail: {
    position: 'absolute',
    transform: [{ rotate: '-45deg' }],
  },
  readingTitle: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 3,
  },
  readingText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    lineHeight: 24,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },

  // Unlock button
  unlockButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 20,
  },
  unlockButtonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.3,
  },
  // Mini sections (advice / next steps)
  miniSection: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    gap: 10,
  },
  miniHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  readingHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  miniHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  miniTitle: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  miniText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 21,
  },

  followUpActions: {
    marginTop: 8,
    gap: 10,
  },
  followUpResponseSection: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    gap: 12,
  },
  followUpResponseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  followUpResponseTitle: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 3,
  },
  followUpResponseBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  followUpResponseBlockTitle: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  followUpButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 214, 102, 0.25)',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  followUpButtonText: {
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
    color: '#F5E3A8',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  followUpButtonPrice: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    color: '#FFD700',
    letterSpacing: 0.5,
    textAlign: 'center',
    marginTop: 4,
  },
  followUpInput: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    backgroundColor: 'rgba(18, 15, 38, 0.8)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: '#F5E3A8',
  },
  followUpDetailFor: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    marginTop: 8,
  },
  followUpCardsWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
  },
  followUpLoadingCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  followUpLoadingText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },

  // Pulse orbit loading
  pulseOrbitContainer: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'visible',
  },
  pulseOrbitGlow: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    opacity: 0.5,
  },
  pulseOrbitGlowSmall: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    opacity: 0.6,
  },
  pulseOrbitCardWrapper: {
    position: 'absolute',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  pulseOrbitCardShadow: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    bottom: 6,
    borderRadius: 14,
    opacity: 0.6,
  },
  pulseOrbitCardImage: {
    width: '100%',
    height: '100%',
    borderRadius: 14,
  },
  pulseOrbitCaptionBox: {
    position: 'absolute',
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
  },
  pulseOrbitDots: {
    flexDirection: 'row',
    gap: 6,
  },
  pulseOrbitDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    opacity: 0.8,
  },
  pulseOrbitCaption: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    textAlign: 'center',
  },
  longOrbitContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'visible',
  },
  longOrbitHalo: {
    position: 'absolute',
    width: 230,
    height: 230,
    borderRadius: 115,
    backgroundColor: 'rgba(201, 168, 76, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(201, 168, 76, 0.22)',
  },
  longOrbitMagneticField: {
    position: 'absolute',
    width: 208,
    height: 208,
    borderRadius: 104,
    borderWidth: 1,
    borderColor: 'rgba(201, 168, 76, 0.3)',
    shadowColor: '#C9A84C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 22,
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 45px rgba(201,168,76,0.25)' } : {}),
  },
  longOrbitStar: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: '#F4E8C1',
    shadowColor: '#C9A84C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 9,
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 16px #C9A84C' } : {}),
  },
  longOrbitCurve: {
    position: 'absolute',
    left: '50%',
    top: '25%',
    borderWidth: 1,
    borderColor: 'rgba(225, 185, 111, 0.45)',
    borderRadius: 999,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 18px rgba(225, 185, 111, 0.18)' }
      : {
          shadowColor: '#E1B96F',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.2,
          shadowRadius: 10,
        }),
  },
  longOrbitCurveCross: {
    borderColor: 'rgba(255, 226, 165, 0.34)',
  },
  longOrbitCard: {
    position: 'absolute',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    ...Platform.select({
      web: { boxShadow: '0 8px 24px rgba(201, 168, 76, 0.32)' },
      default: {
        shadowColor: '#C9A84C',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.32,
        shadowRadius: 18,
        elevation: 8,
      },
    }),
  },
  longOrbitCardLight: {
    position: 'absolute',
    zIndex: 4,
    top: '-5%',
    left: '-12%',
    width: '124%',
    height: '110%',
    borderRadius: 999,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 30px rgba(255, 226, 165, 0.5)' }
      : {
          shadowColor: '#FFE2A5',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.65,
          shadowRadius: 20,
          elevation: 8,
        }),
  },
  longOrbitCaption: {
    position: 'absolute',
    bottom: 4,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
  },
  longOrbitCaptionText: {
    color: '#C9A84C',
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    textAlign: 'center',
  },

  // Error state
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    padding: 18,
  },
  errorTextWrapper: {
    flex: 1,
    gap: 8,
  },
  errorText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 22,
  },
  retryLink: {
    alignSelf: 'flex-start',
  },
  retryLinkText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    textDecorationLine: 'underline',
  },

});
