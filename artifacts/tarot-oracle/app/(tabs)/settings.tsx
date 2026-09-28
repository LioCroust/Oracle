import React, { useCallback, useEffect, useState } from 'react';
import {
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useCredits } from '@/contexts/CreditsContext';
import { STUDIO_VOICES, type StudioVoice } from '@/lib/ttsVoices';
import {
  getSelectedVoice,
  setSelectedVoice,
  subscribeSelectedVoice,
} from '@/lib/voiceStorage';
import { TTS_MODEL } from '@/lib/tts';

const TAROT_BG = require('@/assets/images/tarot-bg.png');

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    balance,
    refresh: refreshWallet,
    loading: walletLoading,
  } = useCredits();

  const [voice, setVoice] = useState<StudioVoice | null>(null);

  useEffect(() => {
    let mounted = true;
    getSelectedVoice()
      .then((v) => {
        if (!mounted) return;
        setVoice(v);
      })
      .catch(() => {
        if (!mounted) return;
        setVoice('Kore');
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const unsubVoice = subscribeSelectedVoice((v) => setVoice(v));
    return unsubVoice;
  }, []);

  const refreshAll = useCallback(async () => {
    await refreshWallet();
  }, [refreshWallet]);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom + 16;
  const selectedVoice = voice ?? 'Kore';

  return (
    <ImageBackground source={TAROT_BG} style={styles.container} resizeMode="cover">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10, 8, 21, 0.6)' }]} />
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: topPad + 20, paddingBottom: bottomPad + 28 },
        ]}
        // Pull-to-refresh only refreshes the credit wallet now — daily /
        // monthly Gemini quotas moved to the admin dashboard where
        // operators can audit them without confusing regular users.
        refreshControl={undefined}
        showsVerticalScrollIndicator={false}
      >
        {/* ─── Header ───────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <Feather name="settings" size={22} color={colors.primary} />
          <Text style={[styles.screenTitle, { color: colors.foreground }]}>
            Options & Crédits
          </Text>
        </View>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Voix de l'oracle et crédits
        </Text>

        {/* ─── Credits wallet ──────────────────────────────────────────────── */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: 'rgba(28, 24, 69, 0.72)',
              borderColor: hexToRgba(colors.primary, 0.5),
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Feather name="gift" size={16} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>
              Crédits
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={[styles.creditBalance, { color: colors.foreground }]}>
              {walletLoading ? '…' : balance}
            </Text>
          </View>
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            1 réponse rapide = 25 crédits, 1 lecture détaillée = 50 crédits
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.cta,
              {
                backgroundColor: pressed
                  ? 'rgba(201, 168, 76, 0.5)'
                  : colors.primary,
                borderColor: hexToRgba(colors.primary, 0.7),
              },
            ]}
            onPress={() => router.navigate('/(tabs)/boutique')}
          >
            <Feather name="shopping-bag" size={14} color={colors.primaryForeground} />
            <Text style={[styles.ctaText, { color: colors.primaryForeground }]}>
              Voir les packs de crédits
            </Text>
          </Pressable>
        </View>

        {/* ─── Voice picker ────────────────────────────────────────────────── */}
        <View
          style={[
            styles.card,
            {
              backgroundColor: 'rgba(28, 24, 69, 0.72)',
              borderColor: hexToRgba(colors.accent, 0.4),
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Feather name="user" size={16} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>
              Voix de l'oracle
            </Text>
            <View style={{ flex: 1 }} />
            <Feather name="check-circle" size={16} color={colors.primary} />
          </View>
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            {TTS_MODEL} · fr-FR · sélectionnez la voix qui récitera vos
            tirages
          </Text>

          <View style={styles.voiceList}>
            {STUDIO_VOICES.map((v) => {
              const isActive = v.id === selectedVoice;
              return (
                <Pressable
                  key={v.id}
                  onPress={async () => {
                    await setSelectedVoice(v.id);
                  }}
                  style={({ pressed }) => [
                    styles.voiceRow,
                    {
                      borderColor: isActive
                        ? hexToRgba(colors.primary, 0.85)
                        : 'rgba(255,255,255,0.10)',
                      backgroundColor: pressed
                        ? hexToRgba(colors.primary, 0.18)
                        : isActive
                        ? hexToRgba(colors.primary, 0.10)
                        : 'rgba(20, 16, 44, 0.55)',
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.voiceLabel,
                        {
                          color: isActive
                            ? colors.primary
                            : colors.foreground,
                        },
                      ]}
                    >
                      {v.label}
                    </Text>
                    <Text
                      style={[styles.voiceHint, { color: colors.mutedForeground }]}
                    >
                      {v.hint}
                    </Text>
                    <Text
                      style={[styles.voiceDesc, { color: colors.mutedForeground }]}
                    >
                      {v.description}
                    </Text>
                  </View>
                  {isActive ? (
                    <Feather name="check" size={20} color={colors.primary} />
                  ) : (
                    <Feather
                      name="circle"
                      size={20}
                      color={hexToRgba(colors.mutedForeground, 0.6)}
                    />
                  )}
                </Pressable>
              );
            })}
          </View>

        </View>

        {/* Quiet refresh button — only the wallet ever needs it now. */}
        <Pressable
          style={({ pressed }) => [
            styles.refreshButton,
            {
              borderColor: hexToRgba(colors.primary, 0.5),
              backgroundColor: pressed
                ? 'rgba(255,255,255,0.10)'
                : 'transparent',
            },
          ]}
          onPress={refreshAll}
        >
          <Feather name="refresh-cw" size={16} color={colors.primary} />
          <Text style={[styles.refreshText, { color: colors.primary }]}>
            Actualiser mon solde
          </Text>
        </Pressable>
      </ScrollView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 8,
  },
  screenTitle: { fontSize: 28, fontFamily: 'Inter_700Bold', letterSpacing: 1 },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginBottom: 24,
  },

  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 10,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  cardTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  meta: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },

  creditBalance: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 12,
  },
  ctaText: { fontSize: 13, fontFamily: 'Inter_700Bold', letterSpacing: 0.6 },

  voiceList: { marginTop: 6, gap: 10 },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  voiceLabel: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  voiceHint: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    marginTop: 2,
    letterSpacing: 0.3,
  },
  voiceDesc: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },

  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 12,
  },
  refreshText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
