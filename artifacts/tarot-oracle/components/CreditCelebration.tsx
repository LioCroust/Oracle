import React, { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCredits } from '@/contexts/CreditsContext';
import { CelebrationOverlay } from './Celebration';

const CELEBRATED_IDS_KEY = '@oracle/celebratedTransactions';

function gainMessage(transaction: {
  type: string;
  creditsDelta: number;
  description: string;
  packId?: string;
}): string {
  const amount = `${transaction.creditsDelta >= 0 ? '+' : ''}${transaction.creditsDelta}`;

  if (transaction.type === 'bonus_initial') {
    return `${amount} crédits offerts — Bienvenue !`;
  }

  if (
    transaction.type === 'purchase_short' ||
    transaction.type === 'purchase_intuition' ||
    transaction.type === 'purchase_premium'
  ) {
    const packName = transaction.description || 'Achat';
    return `${amount} crédits — ${packName}`;
  }

  if (transaction.type === 'admin_adjustment') {
    return `${amount} crédits — Ajustement`;
  }

  return `${amount} crédits`;
}

export function CreditCelebration() {
  const { transactions } = useCredits();
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const celebratedIds = useRef(new Set<string>());
  const celebrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTransactionId = useRef<string | null>(null);
  const handleComplete = useCallback(() => {
    setActive(false);
    setMessage(undefined);
  }, []);

  useEffect(() => {
    return () => {
      if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
    };
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(CELEBRATED_IDS_KEY)
      .then((raw) => {
        if (raw) {
          const ids = JSON.parse(raw) as string[];
          ids.forEach((id) => celebratedIds.current.add(id));
        }
      })
      .finally(() => {
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!loaded) return;

    const newTransactions = transactions.filter((t) => !celebratedIds.current.has(t.id));
    if (newTransactions.length === 0) return;

    const gain = newTransactions.find(
      (t) =>
        (t.type === 'bonus_initial' ||
          t.type === 'purchase_short' ||
          t.type === 'purchase_intuition' ||
          t.type === 'purchase_premium' ||
          t.type === 'admin_adjustment') &&
        t.creditsDelta > 0,
    );

    if (gain) {
      if (activeTransactionId.current === gain.id) return;
      activeTransactionId.current = gain.id;
      setMessage(gainMessage(gain));
      setActive(true);
      if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
      celebrationTimer.current = setTimeout(() => {
        activeTransactionId.current = null;
        handleComplete();
      }, 2800);
    }

    newTransactions.forEach((t) => celebratedIds.current.add(t.id));
    AsyncStorage.setItem(
      CELEBRATED_IDS_KEY,
      JSON.stringify([...celebratedIds.current]),
    ).catch(() => {});
  }, [transactions, loaded, handleComplete]);

  if (!active) return null;

  return <CelebrationOverlay message={message} onComplete={handleComplete} />;
}
