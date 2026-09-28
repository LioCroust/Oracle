import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleProp, TextStyle } from 'react-native';

export function AnimatedBalance({
  balance,
  style,
}: {
  balance: number;
  style: StyleProp<TextStyle>;
}) {
  const [displayedBalance, setDisplayedBalance] = useState(balance);
  const previousBalance = useRef(balance);
  const bounceAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (balance === previousBalance.current) return;

    const isDecrease = balance < previousBalance.current;
    const start = previousBalance.current;
    const end = balance;

    if (isDecrease) {
      const duration = 500;
      const startTime = Date.now();
      const timer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        const value = Math.round(start + (end - start) * ease);
        setDisplayedBalance(value);
        if (progress >= 1) clearInterval(timer);
      }, 16);

      Animated.sequence([
        Animated.timing(bounceAnim, {
          toValue: 1,
          duration: 80,
          useNativeDriver: true,
        }),
        Animated.timing(bounceAnim, {
          toValue: 0,
          duration: 80,
          useNativeDriver: true,
        }),
      ]).start();

      return () => clearInterval(timer);
    } else {
      setDisplayedBalance(end);
    }

    previousBalance.current = balance;
  }, [balance, bounceAnim]);

  const translateY = bounceAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 4],
  });

  return (
    <Animated.Text style={[style, { transform: [{ translateY }] }]}>
      {displayedBalance} crédit{displayedBalance !== 1 ? 's' : ''}
    </Animated.Text>
  );
}
