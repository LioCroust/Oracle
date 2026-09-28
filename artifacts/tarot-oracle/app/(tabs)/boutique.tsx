import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useCredits } from '@/contexts/CreditsContext';
import { MAX_BALANCE } from '@/lib/creditsStorage';

const TAROT_BG = require('@/assets/images/tarot-bg.png');

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
    time: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function BalanceCard({ balance, colors }: { balance: number; colors: any }) {
  return (
    <View
      style={[
        styles.balanceCard,
        {
          backgroundColor: 'rgba(28, 24, 69, 0.72)',
          borderColor: 'rgba(201, 168, 76, 0.35)',
        },
      ]}
    >
      <Feather name="zap" size={24} color={colors.primary} />
      <View style={styles.balanceTextContainer}>
        <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>
          Solde de Crédits
        </Text>
        <Text style={[styles.balanceValue, { color: colors.foreground }]}>
          {balance}
        </Text>
      </View>
    </View>
  );
}

function PackCard({
  pack,
  onBuy,
  colors,
  isBestValue,
  disabled,
  disabledReason,
}: {
  pack: { id: string; label: string; credits: number; amount: number; type?: string };
  onBuy: () => void;
  colors: any;
  isBestValue: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <View
      style={[
        styles.packCard,
        {
          backgroundColor: 'rgba(28, 24, 69, 0.72)',
          borderColor: isBestValue
            ? 'rgba(201, 168, 76, 0.6)'
            : 'rgba(45, 39, 80, 0.8)',
          opacity: disabled ? 0.65 : 1,
        },
      ]}
    >
      {isBestValue && (
        <View style={[styles.bestValueBadge, { backgroundColor: colors.primary }]}>
          <Text style={[styles.bestValueText, { color: colors.primaryForeground }]}>
            Meilleur rapport valeur
          </Text>
        </View>
      )}
      <View style={styles.packHeader}>
        <Text style={[styles.packName, { color: colors.foreground }]}>{pack.label}</Text>
        <Text style={[styles.packCredits, { color: colors.primary }]}>{pack.credits} crédits</Text>
      </View>
      <Text style={[styles.packPrice, { color: colors.mutedForeground }]}>
        {pack.amount.toFixed(2).replace('.', ',')} €
      </Text>
      {disabledReason ? (
        <Text style={[styles.packDisabledReason, { color: colors.mutedForeground }]}>
          {disabledReason}
        </Text>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.buyButton,
          {
            backgroundColor: pressed || disabled ? 'rgba(201, 168, 76, 0.5)' : colors.primary,
          },
        ]}
        onPress={disabled ? undefined : onBuy}
      >
        <Text style={[styles.buyButtonText, { color: colors.primaryForeground }]}>
          Acheter
        </Text>
      </Pressable>
    </View>
  );
}

function TransactionItem({
  transaction,
  index,
  colors,
}: {
  transaction: {
    date: string;
    type: string;
    description: string;
    creditsDelta: number;
    balanceAfter: number;
  };
  index: number;
  colors: any;
}) {
  const { date, time } = formatDateTime(transaction.date);
  const isPositive = transaction.creditsDelta > 0;
  const isPurchase = transaction.type.startsWith('purchase_');
  const isUsage = transaction.type === 'usage_short' || transaction.type === 'usage_detail';
  const isFollowUp =
    transaction.type === 'usage_follow_up_questions' ||
    transaction.type === 'usage_follow_up_detail';

  return (
    <View
      style={[
        styles.historyItem,
        {
          backgroundColor: 'rgba(28, 24, 69, 0.55)',
          borderColor: 'rgba(45, 39, 80, 0.5)',
        },
      ]}
    >
      <View style={styles.historyRow}>
        <Text style={[styles.historyIndex, { color: colors.mutedForeground }]}>
          #{index + 1}
        </Text>
        <View style={styles.historyBadge}>
          <Text
            style={[
              styles.historyBadgeText,
              {
                color: isUsage || isFollowUp ? colors.destructive : isPositive || isPurchase ? colors.primary : colors.accent,
              },
            ]}
          >
            {isUsage || isFollowUp ? 'Utilisation' : isPositive || isPurchase ? 'Achat' : 'Autre'}
          </Text>
        </View>
        <Text
          style={[
            styles.historyCredits,
            { color: isPositive ? colors.primary : colors.foreground },
          ]}
        >
          {isPositive ? '+' : ''}
          {transaction.creditsDelta}
        </Text>
      </View>

      <Text style={[styles.historyDescription, { color: colors.foreground }]} numberOfLines={2}>
        {transaction.description}
      </Text>

      <View style={styles.historyFooter}>
        <Text style={[styles.historyDate, { color: colors.mutedForeground }]}>
          {date} · {time}
        </Text>
        <Text style={[styles.historyBalance, { color: colors.mutedForeground }]}>
          Solde : {transaction.balanceAfter}
        </Text>
      </View>
    </View>
  );
}

export default function BoutiqueScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    balance,
    transactions,
    loading,
    refresh,
    purchasePack,
    restorePurchases,
    packs,
  } = useCredits();

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const handleReturn = useCallback(() => {
    // Prefer popping the navigation stack so we don't fire the Oracle tab's
    // tabPress listener (which would reset the reading). Fall back to a
    // programmatic navigate() — navigate() returns to a tab without firing
    // tabPress — only the physical tab button press triggers the reset.
    if (router.canGoBack()) {
      router.back();
    } else {
      router.navigate('/(tabs)');
    }
  }, [router]);

  const handleBuy = useCallback(
    (packId: string, label: string, credits: number) => {
      if (balance + credits > MAX_BALANCE) {
        Alert.alert(
          'Plafond atteint',
          `Votre solde ne peut pas dépasser ${MAX_BALANCE} crédits. Vous avez actuellement ${balance} crédits. Choisissez un pack plus petit ou consommez des crédits avant d’acheter.`,
        );
        return;
      }

      Alert.alert(
        'Achat de crédits',
        `Confirmer l'achat du ${label} ? Les crédits seront ajoutés à votre solde (achat simulé pour l'instant).`,
        [
          { text: 'Annuler', style: 'cancel' },
          {
            text: 'Confirmer',
            onPress: async () => {
              const ok = await purchasePack(packId);
              if (!ok) {
                Alert.alert('Erreur', "L'achat n'a pas pu être effectué.");
              }
            },
          },
        ],
      );
    },
    [balance, purchasePack],
  );

  const handleRestore = useCallback(async () => {
    const restored = await restorePurchases();
    Alert.alert(
      'Restauration',
      restored
        ? 'Vos achats ont été restaurés.'
        : "Aucun achat à restaurer pour l'instant (Google Play Billing n'est pas encore connecté).",
    );
  }, [restorePurchases]);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom + 16;

  return (
    <ImageBackground source={TAROT_BG} style={styles.container} resizeMode="cover">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10, 8, 21, 0.6)' }]} />

      {/* Floating back button — bottom-left */}
      <Pressable
        onPress={handleReturn}
        accessibilityRole="button"
        accessibilityLabel="Retour à l'oracle"
        style={({ pressed }) => [
          styles.backButton,
          {
            bottom: bottomPad + 18,
            backgroundColor: pressed ? 'rgba(28, 24, 69, 0.92)' : 'rgba(28, 24, 69, 0.78)',
            borderColor: hexToRgba(colors.primary, 0.5),
          },
        ]}
      >
        <Feather name="chevron-left" size={20} color={colors.primary} />
        <Text style={[styles.backButtonText, { color: colors.foreground }]}>Retour</Text>
      </Pressable>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: topPad + 20, paddingBottom: bottomPad + 28 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Feather name="shopping-bag" size={22} color={colors.primary} />
          <Text style={[styles.screenTitle, { color: colors.foreground }]}>Boutique</Text>
        </View>

        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Gérez vos crédits et achetez des packs
        </Text>

        {loading ? (
          <View style={styles.loader}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.loaderText, { color: colors.mutedForeground }]}>
              Chargement du portefeuille…
            </Text>
          </View>
        ) : (
          <>
            <BalanceCard balance={balance} colors={colors} />

            {/* Standard packs */}
            <Text
              style={[
                styles.sectionTitle,
                { color: colors.foreground, marginTop: 24 },
              ]}
            >
              Packs disponibles
            </Text>
            <View style={styles.packsGrid}>
              {packs.map((pack) => {
                const wouldExceed = balance + pack.credits > MAX_BALANCE;
                return (
                  <PackCard
                    key={pack.id}
                    pack={pack}
                    colors={colors}
                    isBestValue={pack.id === 'intuition'}
                    disabled={wouldExceed}
                    disabledReason={
                      wouldExceed
                        ? `Vous avez atteint la limite autorisée. Consommez des crédits avant d’acheter ce pack.`
                        : undefined
                    }
                    onBuy={() => handleBuy(pack.id, pack.label, pack.credits)}
                  />
                );
              })}
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.restoreButton,
                {
                  backgroundColor: pressed ? 'rgba(255,255,255,0.12)' : 'transparent',
                  borderColor: colors.border,
                },
              ]}
              onPress={handleRestore}
            >
              <Feather name="refresh-ccw" size={16} color={colors.primary} />
              <Text style={[styles.restoreButtonText, { color: colors.primary }]}>
                Restaurer les achats
              </Text>
            </Pressable>

            {/* Transactions history */}
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Historique des transactions
            </Text>

            {transactions.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={[styles.emptyHistoryText, { color: colors.mutedForeground }]}>
                  Aucune transaction pour l'instant.
                </Text>
              </View>
            ) : (
              <View style={styles.historyList}>
                {transactions.map((tx, index) => (
                  <TransactionItem
                    key={tx.id}
                    index={index}
                    colors={colors}
                    transaction={{
                      date: new Date(tx.timestamp).toISOString(),
                      type: tx.type,
                      description: tx.description,
                      creditsDelta: tx.creditsDelta,
                      balanceAfter: tx.balanceAfter,
                    }}
                  />
                ))}
              </View>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.refreshButton,
                {
                  backgroundColor: pressed ? 'rgba(255,255,255,0.12)' : 'transparent',
                  borderColor: colors.primary,
                },
              ]}
              onPress={refresh}
            >
              <Feather name="refresh-cw" size={16} color={colors.primary} />
              <Text style={[styles.refreshButtonText, { color: colors.primary }]}>
                Actualiser
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 8,
  },
  screenTitle: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginBottom: 24,
  },
  backButton: {
    position: 'absolute',
    left: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    zIndex: 10,
  },
  backButtonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.3,
  },
  loader: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 14,
  },
  loaderText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },

  // Balance card
  balanceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
  },
  balanceTextContainer: {
    flex: 1,
  },
  balanceLabel: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    marginBottom: 4,
  },
  balanceValue: {
    fontSize: 36,
    fontFamily: 'Inter_700Bold',
  },
  balanceCap: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
    opacity: 0.8,
  },

  // Packs
  sectionTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 14,
    marginTop: 8,
  },
  packsGrid: {
    gap: 12,
    marginBottom: 16,
  },
  packCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    gap: 10,
    overflow: 'hidden',
  },
  bestValueBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomLeftRadius: 12,
  },
  bestValueText: {
    fontSize: 9,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  packHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  packName: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  packCredits: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  packPrice: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
  },
  packDisabledReason: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  buyButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buyButtonText: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
  },

  // Restore & refresh buttons
  restoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 24,
  },
  restoreButtonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 8,
  },
  refreshButtonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },

  // History
  emptyHistory: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  emptyHistoryText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  historyList: {
    gap: 10,
  },
  historyItem: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  historyIndex: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    width: 40,
  },
  historyBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  historyBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  historyCredits: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  historyDescription: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  historyFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyDate: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  historyBalance: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
});
