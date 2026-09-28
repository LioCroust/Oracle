import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const CELEBRATION_COLORS = [
  '#FFD700', // gold
  '#FF6B6B', // coral
  '#4ECDC4', // turquoise
  '#C9A84C', // antique gold
  '#9B59B6', // purple
  '#FF9F43', // orange
  '#6C5CE7', // violet
];

interface ParticleConfig {
  id: string;
  color: string;
  size: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  delay: number;
  duration: number;
  shape: 'circle' | 'square';
}

function generateBurst(centerX: number, centerY: number, count: number): ParticleConfig[] {
  return Array.from({ length: count }).map((_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const distance = 120 + Math.random() * 220;
    const endX = Math.cos(angle) * distance;
    const endY = Math.sin(angle) * distance + 80 + Math.random() * 120; // add gravity
    return {
      id: `p-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      color: CELEBRATION_COLORS[Math.floor(Math.random() * CELEBRATION_COLORS.length)],
      size: 6 + Math.random() * 10,
      startX: centerX,
      startY: centerY,
      endX,
      endY,
      delay: Math.random() * 120,
      duration: 1400 + Math.random() * 900,
      shape: Math.random() > 0.6 ? 'square' : 'circle',
    };
  });
}

function generateFireworks(): ParticleConfig[] {
  const bursts = 3 + Math.floor(Math.random() * 2);
  let particles: ParticleConfig[] = [];
  for (let b = 0; b < bursts; b++) {
    const centerX = SCREEN_WIDTH * (0.2 + Math.random() * 0.6);
    const centerY = SCREEN_HEIGHT * (0.25 + Math.random() * 0.35);
    const count = 28 + Math.floor(Math.random() * 16);
    particles = particles.concat(generateBurst(centerX, centerY, count));
  }
  return particles;
}

function Particle({ config }: { config: ParticleConfig }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration: config.duration,
      delay: config.delay,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [anim, config.duration, config.delay]);

  const opacity = anim.interpolate({
    inputRange: [0, 0.15, 0.7, 1],
    outputRange: [0, 1, 0.8, 0],
  });

  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, config.endX],
  });

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, config.endY],
  });

  const scale = anim.interpolate({
    inputRange: [0, 0.2, 0.8, 1],
    outputRange: [0.3, 1, 1, 0.2],
  });

  const rotation = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', `${Math.random() > 0.5 ? '' : '-'}${180 + Math.random() * 180}deg`],
  });

  return (
    <Animated.View
      style={[
        styles.particle,
        {
          left: config.startX,
          top: config.startY,
          width: config.size,
          height: config.size,
          borderRadius: config.shape === 'circle' ? config.size / 2 : 2,
          backgroundColor: config.color,
          opacity,
          transform: [{ translateX }, { translateY }, { scale }, { rotate: rotation }],
        },
      ]}
      pointerEvents="none"
    />
  );
}

interface CelebrationOverlayProps {
  message?: string;
  onComplete?: () => void;
}

export function CelebrationOverlay({ message, onComplete }: CelebrationOverlayProps) {
  const [particles] = useState(() => generateFireworks());
  const messageAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(messageAnim, {
      toValue: 1,
      friction: 6,
      tension: 80,
      useNativeDriver: true,
    }).start();
  }, [messageAnim]);

  return (
    <View style={styles.overlay} pointerEvents="none">
      {particles.map((p) => (
        <Particle key={p.id} config={p} />
      ))}

      {message ? (
        <Animated.View
          style={[
            styles.messageContainer,
            {
              opacity: messageAnim,
              transform: [
                {
                  scale: messageAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.8, 1],
                  }),
                },
                {
                  translateY: messageAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [20, 0],
                  }),
                },
              ],
            },
          ]}
          pointerEvents="none"
        >
          <View style={styles.messageCard}>
            <Text style={styles.message}>{message}</Text>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 9999,
    elevation: 9999,
  },
  particle: {
    position: 'absolute',
  },
  messageContainer: {
    position: 'absolute',
    top: SCREEN_HEIGHT * 0.28,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  messageCard: {
    maxWidth: '100%',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(16, 13, 32, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255, 215, 0, 0.45)',
  },
  message: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: '#FFD700',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
});
