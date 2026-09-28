import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAdminStats } from '@/hooks/useAdminStats';
import { clearHistory, isAdminAuthenticated, loginAdmin, logoutAdmin } from '@/lib/adminStorage';
import type { ResponseType } from '@/lib/adminStorage';
import { useAdminAccess } from '@/contexts/AdminAccessContext';
import {
  subscribeAudioLog,
  getServerAudioStats,
  clearAudioLog,
  type AudioLogEntry,
  type ServerAudioStats,
} from '@/lib/tts';

const TAROT_BG = require('@/assets/images/tarot-bg.png');

function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatTime(ms: number): string {
  if (ms <= 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
    time: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
}

function StatCard({
  title,
  shortReadings,
  detailReadings,
  totalDraws,
  creditsUsed,
  avgGenerationTimeMs,
  accent,
}: {
  title: string;
  shortReadings: number;
  detailReadings: number;
  totalDraws: number;
  creditsUsed: number;
  avgGenerationTimeMs: number;
  accent: string;
}) {
  const colors = useColors();

  return (
    <View
      style={[
        styles.statCard,
        {
          backgroundColor: 'rgba(28, 24, 69, 0.72)',
          borderColor: hexToRgba(accent, 0.35),
        },
      ]}
    >
      <View style={styles.statCardHeader}>
        <View style={[styles.statDot, { backgroundColor: accent }]} />
        <Text style={[styles.statCardTitle, { color: accent }]}>{title}</Text>
      </View>

      <View style={styles.statRow}>
        <View style={styles.statCell}>
          <Text style={[styles.statValue, { color: colors.foreground }]}>{shortReadings}</Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
            Réponses rapides
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={[styles.statValue, { color: colors.foreground }]}>{detailReadings}</Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
            Réponses détaillées
          </Text>
        </View>
      </View>

      <View style={styles.statRow}>
        <View style={styles.statCell}>
          <Text style={[styles.statValue, { color: colors.foreground }]}>{totalDraws}</Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
            Total tirages
          </Text>
        </View>
        <View style={styles.statCell}>
          <Text style={[styles.statValue, { color: colors.foreground }]}>{creditsUsed}</Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
            Crédits utilisés
          </Text>
        </View>
      </View>

      <View style={styles.statFooter}>
        <Feather name="clock" size={12} color={colors.mutedForeground} />
        <Text style={[styles.statFooterText, { color: colors.mutedForeground }]}>
          Temps moyen : {formatTime(avgGenerationTimeMs)}
        </Text>
      </View>
    </View>
  );
}

function HistoryItem({
  event,
  index,
  colors,
}: {
  event: { date: string; question: string; responseType: ResponseType; creditsUsed: number };
  index: number;
  colors: any;
}) {
  const { date, time } = formatDateTime(event.date);
  const responseTypeLabel = (type: ResponseType) => {
    switch (type) {
      case 'detail':
        return 'Détaillée';
      case 'follow_up_questions':
        return 'Questions de suivi';
      case 'follow_up_detail':
        return 'Réponse de suivi';
      case 'short':
      default:
        return 'Rapide';
    }
  };

  return (
    <View
      style={[
        styles.historyItem,
        {
          backgroundColor: 'rgba(28, 24, 69, 0.55)',
          borderColor: hexToRgba(colors.border, 0.5),
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
              { color: event.responseType === 'detail' ? colors.primary : colors.accent },
            ]}
          >
            {responseTypeLabel(event.responseType)}
          </Text>
        </View>
        <Text style={[styles.historyCredits, { color: colors.mutedForeground }]}>
          {event.creditsUsed} crédit{event.creditsUsed > 1 ? 's' : ''}
        </Text>
      </View>

      <Text style={[styles.historyQuestion, { color: colors.foreground }]} numberOfLines={2}>
        {event.question}
      </Text>

      <Text style={[styles.historyDate, { color: colors.mutedForeground }]}>
        {date} · {time}
      </Text>
    </View>
  );
}

// Structural shape of what `useColors()` returns — only the fields the
// audio-daily pill helpers actually read. Defining this by hand sidesteps
// `ReturnType<typeof useColors>`-style generic syntax because the TSX
// parser has historically refused to consume `<...>` after `typeof` even
// when it's purely in type-position.
type ColorPalette = {
  destructive: string;
  accent: string;
  border: string;
  mutedForeground: string;
  foreground: string;
};

// Compact visual helper for the daily-quota pill. Pulled out of the JSX so
// the parser doesn't trip on long inline ternaries — and so the same logic
// (exhausted → destructive, warming → accent, ok → muted) is shared by the
// primary and the backup pill.
function dailyPillProps(
  colors: ColorPalette,
  used: number,
  limit: number,
  thresholdPct: number,
) {
  const exhausted = used >= limit;
  const warnLevel = (thresholdPct * limit) / 100;
  const warning = !exhausted && used >= warnLevel;
  return {
    backgroundColor: exhausted
      ? hexToRgba(colors.destructive, 0.12)
      : warning
        ? hexToRgba(colors.accent, 0.12)
        : hexToRgba(colors.accent, 0.05),
    borderColor: exhausted
      ? colors.destructive
      : warning
        ? colors.accent
        : hexToRgba(colors.border, 0.6),
    labelColor: exhausted ? colors.destructive : colors.mutedForeground,
    valueColor: exhausted ? colors.destructive : colors.foreground,
  };
}

// Plain helper — *not* a React component — so callers write
// `{renderDailyPill(...)}` and never `<renderDailyPill ...>`. The JSX parser
// in `.tsx` has historically been picky about custom JSX elements whose
// identifier matches a TypeScript generic-parameter list, so going through
// a function call here keeps the parser happy without losing any typing.
function renderDailyPill(
  colors: ColorPalette,
  label: string,
  daily: { dateKey: string; used: number; limit: number },
  thresholdPct: number,
) {
  const pill = dailyPillProps(colors, daily.used, daily.limit, thresholdPct);
  return (
    <View
      style={[
        styles.audioDailyPill,
        { backgroundColor: pill.backgroundColor, borderColor: pill.borderColor },
      ]}
    >
      <Text style={[styles.audioDailyPillLabel, { color: pill.labelColor }]}>
        {label}
      </Text>
      <Text style={[styles.audioDailyPillValue, { color: pill.valueColor }]}>
        {daily.used} / {daily.limit}
      </Text>
      <Text style={[styles.audioDailyPillDate, { color: colors.mutedForeground }]}>
        {daily.dateKey} PT
      </Text>
    </View>
  );
}

// Helper: render the entire "Quotas 24h Pacific" card. Pulled out of the
// AudioSection body because the inline JSX inside the card uses a `cond ? A
// : (B)` ternary that the TSX parser has historically tripped on when it
// sat inside `{stats.daily ? (` — keeping it inside a function lets us
// return the JSX from a normal arrow-style body without nesting a parenthesized
// JSX block as the "true" branch of an outer ternary.
function renderDailyStrip(
  colors: ColorPalette,
  daily: NonNullable<ServerAudioStats['daily']>,
  projects: ServerAudioStats['projects'] | undefined,
) {
  return (
    <View
      style={[
        styles.audioDailyCard,
        {
          backgroundColor: 'rgba(28, 24, 69, 0.55)',
          borderColor: hexToRgba(colors.border, 0.5),
        },
      ]}
    >
      <Text
        style={[styles.audioDailyTitle, { color: colors.mutedForeground }]}
      >
        Quotas 24h Pacific — cap {daily.limit} requêtes / projet
      </Text>
      <View style={styles.audioDailyPills}>
        {renderDailyPill(
          colors,
          'Principal',
          daily.primary,
          daily.thresholdPct,
        )}
        {daily.backup
          ? renderDailyPill(
              colors,
              'Secours',
              daily.backup,
              daily.thresholdPct,
            )
          : (
            <View
              style={[
                styles.audioDailyPill,
                styles.audioDailyPillDisabled,
                { borderColor: hexToRgba(colors.border, 0.3) },
              ]}
            >
              <Text
                style={[styles.audioDailyPillLabel, { color: colors.mutedForeground }]}
              >
                Secours
              </Text>
              <Text
                style={[styles.audioDailyPillValue, { color: colors.mutedForeground }]}
              >
                — clé non chargée
              </Text>
              <Text
                style={[styles.audioDailyPillDate, { color: colors.mutedForeground }]}
              >
                ajouter GEMINI_API_KEY_BACKUP
              </Text>
            </View>
          )}
        {daily.vertex ? renderDailyPill(
          colors,
          'Vertex',
          daily.vertex,
          daily.thresholdPct,
        ) : null}
      </View>
      {projects && (
        <Text
          style={[styles.audioDailyNote, { color: colors.mutedForeground }]}
        >
          {projects.active === 'backup'
            ? '🟠 Bascule actuellement sur le projet secours.'
            : '🟢 Le serveur utilise actuellement le projet principal.'}{' '}
          {projects.note}
        </Text>
      )}
    </View>
  );
}

function AudioSection({
  stats,
  localLog,
  lastError,
  onRefresh,
  onClearLocal,
}: {
  stats: ServerAudioStats | null;
  localLog: AudioLogEntry[];
  lastError: string | null;
  onRefresh: () => void;
  onClearLocal: () => void;
}) {
  const colors = useColors();
  const geminiColor = colors.primary;

  return (
    <View style={styles.audioSection}>
      <View style={styles.audioSectionHeader}>
        <View style={styles.audioSectionTitleRow}>
          <Feather name="volume-2" size={14} color={colors.accent} />
          <Text style={[styles.audioSectionTitle, { color: colors.foreground }]}>
            AUDIO
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.audioRefreshButton,
            { opacity: pressed ? 0.6 : 1 },
          ]}
          onPress={onRefresh}
        >
          <Feather name="refresh-cw" size={14} color={colors.accent} />
          <Text style={[styles.audioRefreshText, { color: colors.accent }]}>
            Actualiser
          </Text>
        </Pressable>
      </View>

      {lastError ? (
        <View
          style={[
            styles.audioErrorBox,
            {
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              borderColor: hexToRgba(colors.destructive, 0.4),
            },
          ]}
        >
          <Feather name="alert-triangle" size={12} color={colors.destructive} />
          <Text style={[styles.audioErrorText, { color: colors.mutedForeground }]}>
            {lastError}
          </Text>
        </View>
      ) : null}

      {stats ? (
        <View
          style={[
            styles.audioQuotaCard,
            {
              backgroundColor: 'rgba(28, 24, 69, 0.72)',
              borderColor: hexToRgba(colors.accent, 0.35),
            },
          ]}
        >
          <View style={styles.audioQuotaHeader}>
            <View style={styles.audioQuotaTexts}>
              <Text style={[styles.audioQuotaLabel, { color: colors.mutedForeground }]}>
                Quota mensuel Gemini ({stats.quota.monthKey})
              </Text>
              <Text style={[styles.audioQuotaValue, { color: colors.foreground }]}>
                {stats.quota.chars.toLocaleString('fr-FR')} /{' '}
                {stats.quota.limit.toLocaleString('fr-FR')} car.
              </Text>
            </View>
            <Text
              style={[
                styles.audioQuotaPercent,
                {
                  color: stats.quota.percent > 80 ? colors.destructive : colors.accent,
                },
              ]}
            >
              {stats.quota.percent.toFixed(2)} %
            </Text>
          </View>
          <View
            style={[
              styles.audioMeterTrack,
              { backgroundColor: hexToRgba(colors.accent, 0.15) },
            ]}
          >
            <View
              style={[
                styles.audioMeterFill,
                {
                  width: `${Math.max(2, stats.quota.percent)}%`,
                  backgroundColor:
                    stats.quota.percent > 80 ? colors.destructive : colors.accent,
                },
              ]}
            />
          </View>
          <Text style={[styles.audioQuotaFooter, { color: colors.mutedForeground }]}>
            Tokens Gemini — entrée :{' '}
            {stats.quota.inputTokens.toLocaleString('fr-FR')} · sortie :{' '}
            {stats.quota.outputTokens.toLocaleString('fr-FR')}
          </Text>
          <Text style={[styles.audioQuotaFooter, { color: colors.mutedForeground }]}>
            Voix : {stats.voice} · Modèle : {stats.model} · Langue : {stats.language}
          </Text>
          {stats.rpm ? (
            <Text style={[styles.audioQuotaFooter, { color: colors.accent }]}>
              RPM (60 s) : {stats.rpm.total} total · principal {stats.rpm.primary}
              {stats.rpm.backup !== null ? ` · secours ${stats.rpm.backup}` : ''}
              {stats.rpm.vertex !== null ? ` · Vertex ${stats.rpm.vertex}` : ''}
            </Text>
          ) : null}
          {stats.daily && renderDailyStrip(colors, stats.daily, stats.projects ?? undefined)}
        </View>
      ) : (
        <View style={styles.audioLoadingBox}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.audioLoadingText, { color: colors.mutedForeground }]}>
            Chargement des statistiques audio…
          </Text>
        </View>
      )}

      {stats ? (
        <>
          <View style={styles.audioStatGrid}>
            <View
              style={[
                styles.audioStatCell,
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.55)',
                  borderColor: hexToRgba(colors.border, 0.5),
                },
              ]}
            >
              <Text style={[styles.audioStatValue, { color: colors.foreground }]}>
                {stats.totalCount}
              </Text>
              <Text style={[styles.audioStatLabel, { color: colors.mutedForeground }]}>
                lectures (serveur)
              </Text>
            </View>
            <View
              style={[
                styles.audioStatCell,
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.55)',
                  borderColor: hexToRgba(colors.border, 0.5),
                },
              ]}
            >
              <Text
                style={[
                  styles.audioStatValue,
                  { color: stats.fallbackRate > 25 ? colors.destructive : colors.foreground },
                ]}
              >
                {stats.fallbackRate.toFixed(1)} %
              </Text>
              <Text style={[styles.audioStatLabel, { color: colors.mutedForeground }]}>
                fallback ({stats.fallbackCount})
              </Text>
            </View>
            <View
              style={[
                styles.audioStatCell,
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.55)',
                  borderColor: hexToRgba(colors.border, 0.5),
                },
              ]}
            >
              <Text style={[styles.audioStatValue, { color: colors.foreground }]}>
                {formatTime(stats.avgLatencyMs)}
              </Text>
              <Text style={[styles.audioStatLabel, { color: colors.mutedForeground }]}>
                latence moyenne
              </Text>
            </View>
            <View
              style={[
                styles.audioStatCell,
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.55)',
                  borderColor: hexToRgba(colors.border, 0.5),
                },
              ]}
            >
              <Text style={[styles.audioStatValue, { color: colors.accent }]}>
                {formatTime(stats.avgFirstAudioLatencyMs)}
              </Text>
              <Text style={[styles.audioStatLabel, { color: colors.mutedForeground }]}>
                premier audio moyen
              </Text>
            </View>
          </View>

          <View
            style={[
              styles.audioClientMetricBox,
              {
                backgroundColor: 'rgba(28, 24, 69, 0.55)',
                borderColor: hexToRgba(colors.accent, 0.35),
              },
            ]}
          >
            <View style={styles.audioClientMetricHeader}>
              <Feather name="clock" size={13} color={colors.accent} />
              <Text style={[styles.audioClientMetricTitle, { color: colors.accent }]}>
                EXPÉRIENCE ORACLE → PREMIER SON
              </Text>
            </View>
            <Text style={[styles.audioClientMetricValue, { color: colors.foreground }]}>
              {formatTime(stats.clientMetrics.avgOracleToFirstAudioMs)}
            </Text>
            <Text style={[styles.audioClientMetricDescription, { color: colors.mutedForeground }]}>
              moyenne réelle après affichage de l’Oracle · {stats.clientMetrics.count} mesure
              {stats.clientMetrics.count === 1 ? '' : 's'} · préparation audio moyenne{' '}
              {formatTime(stats.clientMetrics.avgPreparationMs)}
            </Text>
          </View>

          <View style={styles.audioList}>
            <View style={styles.audioListHeader}>
              <Text style={[styles.audioListTitle, { color: colors.mutedForeground }]}>
                Lectures récentes (serveur — dernières {Math.min(stats.recent.length, 8)})
              </Text>
            </View>
            {stats.recent.length === 0 ? (
              <Text style={[styles.audioEmpty, { color: colors.mutedForeground }]}>
                Aucune lecture enregistrée côté serveur pour l'instant.
              </Text>
            ) : (
              stats.recent.slice(0, 8).map((entry) => (
                <View
                  key={entry.id}
                  style={[
                    styles.audioItem,
                    {
                      backgroundColor: 'rgba(28, 24, 69, 0.55)',
                      borderLeftColor: entry.fallback ? colors.destructive : geminiColor,
                      borderColor: hexToRgba(colors.border, 0.5),
                    },
                  ]}
                >
                  <View style={styles.audioItemRow}>
                    <Feather
                      name={entry.fallback ? 'mic-off' : 'zap'}
                      size={12}
                      color={entry.fallback ? colors.destructive : colors.primary}
                    />
                    <Text
                      style={[
                        styles.audioItemSource,
                        { color: entry.fallback ? colors.destructive : colors.primary },
                      ]}
                    >
                      {entry.fallback ? 'fallback' : 'gemini'}
                    </Text>
                    {entry.reason ? (
                      <Text
                        style={[styles.audioItemReason, { color: colors.destructive }]}
                      >
                        · {entry.reason === 'quota' ? 'quota épuisée' : entry.reason}
                      </Text>
                    ) : null}
                    <Text style={[styles.audioItemChars, { color: colors.mutedForeground }]}>
                      {entry.chars} car. · premier son{' '}
                      {formatTime(entry.firstAudioLatencyMs ?? 0)} · total{' '}
                      {formatTime(entry.latencyMs)}
                    </Text>
                  </View>
                  <Text
                    style={[styles.audioItemPreview, { color: colors.foreground }]}
                    numberOfLines={2}
                  >
                    {entry.textPreview}
                  </Text>
                </View>
              ))
            )}
          </View>

          {stats.clientMetrics.recent.length > 0 ? (
            <View style={styles.audioList}>
              <View style={styles.audioListHeader}>
                <Text style={[styles.audioListTitle, { color: colors.mutedForeground }]}>
                  Mesures Oracle → son (dernières {Math.min(stats.clientMetrics.recent.length, 8)})
                </Text>
              </View>
              {stats.clientMetrics.recent.slice(0, 8).map((entry) => (
                <View
                  key={entry.id}
                  style={[
                    styles.audioItem,
                    {
                      backgroundColor: 'rgba(28, 24, 69, 0.55)',
                      borderLeftColor: entry.cacheHit ? colors.primary : colors.accent,
                      borderColor: hexToRgba(colors.border, 0.5),
                    },
                  ]}
                >
                  <View style={styles.audioItemRow}>
                    <Feather name="activity" size={12} color={colors.accent} />
                    <Text style={[styles.audioItemSource, { color: colors.accent }]}>
                      {formatTime(entry.oracleToFirstAudioMs)}
                    </Text>
                    <Text style={[styles.audioItemChars, { color: colors.mutedForeground }]}>
                      {entry.cacheHit ? 'cache' : 'préparation'} ·{' '}
                      {formatTime(entry.preparationMs ?? 0)}
                    </Text>
                  </View>
                  <Text
                    style={[styles.audioItemPreview, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {entry.textPreview}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      <View style={styles.audioList}>
        <View style={styles.audioListHeader}>
          <Text style={[styles.audioListTitle, { color: colors.mutedForeground }]}>
            Lectures sur cet appareil ({localLog.length})
          </Text>
          {localLog.length > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.audioClearButton,
                { opacity: pressed ? 0.6 : 1 },
              ]}
              onPress={onClearLocal}
            >
              <Text style={[styles.audioClearText, { color: colors.mutedForeground }]}>
                Effacer
              </Text>
            </Pressable>
          ) : null}
        </View>
        {localLog.length === 0 ? (
          <Text style={[styles.audioEmpty, { color: colors.mutedForeground }]}>
            Pas encore d'écoute sur cette session.
          </Text>
        ) : (
          localLog.slice(0, 8).map((entry) => (
            <View
              key={entry.id}
              style={[
                styles.audioItem,
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.55)',
                  borderLeftColor: entry.fallback ? colors.destructive : geminiColor,
                  borderColor: hexToRgba(colors.border, 0.5),
                },
              ]}
            >
              <View style={styles.audioItemRow}>
                <Feather
                  name={entry.cacheHit ? 'cpu' : entry.fallback ? 'mic-off' : 'zap'}
                  size={12}
                  color={
                    entry.cacheHit
                      ? colors.accent
                      : entry.fallback
                        ? colors.destructive
                        : colors.primary
                  }
                />
                <Text
                  style={[
                    styles.audioItemSource,
                    {
                      color: entry.cacheHit
                        ? colors.accent
                        : entry.fallback
                          ? colors.destructive
                          : colors.primary,
                    },
                  ]}
                >
                  {entry.cacheHit ? 'cache hit' : entry.fallback ? 'fallback' : 'gemini'}
                </Text>
                {entry.reason ? (
                  <Text
                    style={[styles.audioItemReason, { color: colors.destructive }]}
                  >
                    · {entry.reason === 'quota' ? 'quota épuisée' : entry.reason}
                  </Text>
                ) : null}
                <Text style={[styles.audioItemChars, { color: colors.mutedForeground }]}>
                  {entry.chars} car. · {formatTime(entry.latencyMs)}
                </Text>
              </View>
              <Text
                style={[styles.audioItemPreview, { color: colors.foreground }]}
                numberOfLines={2}
              >
                {entry.textPreview}
              </Text>
              {entry.cacheHit ? (
                <Text style={[styles.audioItemHint, { color: colors.mutedForeground }]}>
                  Ré-écoute instantanée — cache mémoire local
                </Text>
              ) : null}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function LastReadingSection({
  stats,
  lastError,
  onRefresh,
}: {
  stats: ServerAudioStats | null;
  lastError: string | null;
  onRefresh: () => void;
}) {
  const colors = useColors();
  const timeline = stats?.lastReading;

  return (
    <View style={styles.audioSection}>
      <View style={styles.audioSectionHeader}>
        <View style={styles.audioSectionTitleRow}>
          <Feather name="clock" size={14} color={colors.accent} />
          <Text style={[styles.audioSectionTitle, { color: colors.foreground }]}>
            DERNIÈRE LECTURE
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.audioRefreshButton,
            { opacity: pressed ? 0.6 : 1 },
          ]}
          onPress={onRefresh}
        >
          <Feather name="refresh-cw" size={14} color={colors.accent} />
          <Text style={[styles.audioRefreshText, { color: colors.accent }]}>
            Actualiser
          </Text>
        </Pressable>
      </View>

      {lastError ? (
        <View
          style={[
            styles.audioErrorBox,
            {
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              borderColor: hexToRgba(colors.destructive, 0.4),
            },
          ]}
        >
          <Feather name="alert-triangle" size={12} color={colors.destructive} />
          <Text style={[styles.audioErrorText, { color: colors.mutedForeground }]}>
            {lastError}
          </Text>
        </View>
      ) : null}

      <View
        style={[
          styles.audioClientMetricBox,
          {
            backgroundColor: 'rgba(28, 24, 69, 0.72)',
            borderColor: hexToRgba(colors.accent, 0.35),
          },
        ]}
      >
        {!stats ? (
          <View style={styles.audioLoadingBox}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={[styles.audioLoadingText, { color: colors.mutedForeground }]}>
              Chargement…
            </Text>
          </View>
        ) : !timeline ? (
          <Text style={[styles.audioEmpty, { color: colors.mutedForeground }]}>
            Aucune lecture récente enregistrée.
          </Text>
        ) : (
          <>
            <Text style={[styles.audioClientMetricTitle, { color: colors.accent }]}>
              Dernière lecture
            </Text>
            <Text style={[styles.timelineLine, { color: colors.foreground }]}>
              génération du texte : {formatTime(timeline.generationTimeMs)}
            </Text>
            {timeline.tts.map((entry, index) => (
              <Text
                key={entry.id}
                style={[styles.timelineLine, { color: colors.foreground }]}
              >
                {index === 0 ? 'premier appel TTS court' : `appel TTS ${index + 1}`} : audio
                disponible après{' '}
                <Text style={{ color: entry.fallback ? colors.destructive : colors.accent }}>
                  {formatTime(entry.firstAudioLatencyMs ?? 0)}
                </Text>
              </Text>
            ))}
          </>
        )}
      </View>
    </View>
  );
}

function AdminLoginGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const colors = useColors();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async () => {
    setLoading(true);
    setError(false);
    const ok = await loginAdmin(password);
    setLoading(false);
    if (ok) {
      onAuthenticated();
    } else {
      setError(true);
    }
  }, [password, onAuthenticated]);

  return (
    <View style={styles.loginContainer}>
      <View style={styles.loginCard}>
        <Feather name="lock" size={32} color={colors.primary} />
        <Text style={[styles.loginTitle, { color: colors.foreground }]}>
          Accès administration
        </Text>
        <Text style={[styles.loginSubtitle, { color: colors.mutedForeground }]}>
          Saisissez le mot de passe admin pour consulter les statistiques.
        </Text>
        <TextInput
          style={[
            styles.loginInput,
            {
              borderColor: error ? colors.destructive : colors.border,
              color: colors.foreground,
              backgroundColor: 'rgba(28, 24, 69, 0.55)',
            },
          ]}
          placeholder="Mot de passe"
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            setError(false);
          }}
          onSubmitEditing={handleSubmit}
          editable={!loading}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {error && (
          <Text style={[styles.loginError, { color: colors.destructive }]}>
            Mot de passe incorrect.
          </Text>
        )}
        <Pressable
          style={({ pressed }) => [
            styles.loginButton,
            { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
          ]}
          onPress={handleSubmit}
          disabled={loading || !password}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={[styles.loginButtonText, { color: colors.primaryForeground }]}>
              Se connecter
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function AdminDashboard() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { lockAdmin } = useAdminAccess();
  const { stats, history, loading, refresh } = useAdminStats();

  const [activeTab, setActiveTab] = useState<'historique' | 'audio'>('historique');

  const [audioStats, setAudioStats] = useState<ServerAudioStats | null>(null);
  const [audioLog, setAudioLog] = useState<AudioLogEntry[]>([]);
  const [audioLastError, setAudioLastError] = useState<string | null>(null);

  const refreshAudioStats = useCallback(async () => {
    const data = await getServerAudioStats();
    if (data) {
      setAudioStats(data);
      setAudioLastError(null);
    } else {
      setAudioLastError('Indisponible — serveur inaccessible');
    }
  }, []);

  useEffect(() => {
    refreshAudioStats();
    const interval = setInterval(refreshAudioStats, 5000);
    return () => clearInterval(interval);
  }, [refreshAudioStats]);

  useEffect(() => {
    const unsubscribe = subscribeAudioLog(setAudioLog);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleBack = useCallback(() => {
    // Logging out re-renders the same component into its `isAdminAuthenticated
    // === false` branch — i.e. the login form takes over without popping
    // /admin off the navigator stack. This avoids the surprise of being
    // dropped onto a fresh tarot question when the user only meant to lock
    // the admin panel.
    lockAdmin();
    logoutAdmin();
  }, [lockAdmin]);

  const handleClear = useCallback(() => {
    Alert.alert(
      'Réinitialiser les statistiques',
      'Cette action supprime tout l’historique et les statistiques du serveur. Les tirages eux-mêmes ne sont pas conservés, seule la trace d’utilisation disparaît.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Réinitialiser',
          style: 'destructive',
          onPress: async () => {
            await clearHistory();
            refresh();
          },
        },
      ],
    );
  }, [refresh]);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom + 16;

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scrollContent,
        { paddingTop: topPad + 20, paddingBottom: bottomPad + 28 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [
            styles.backButton,
            { backgroundColor: pressed ? 'rgba(255,255,255,0.12)' : 'transparent' },
          ]}
          onPress={handleBack}
        >
          <Feather name="arrow-left" size={18} color={colors.primary} />
          <Text style={[styles.backButtonText, { color: colors.primary }]}>Retour</Text>
        </Pressable>
        <Text style={[styles.screenTitle, { color: colors.foreground }]}>Administration</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Tableau de bord d’utilisation
      </Text>

      {/* Page selector — 2 large buttons */}
      <View style={styles.tabBar}>
        <Pressable
          style={({ pressed }) => [
            styles.tabButton,
            {
              backgroundColor:
                activeTab === 'historique'
                  ? hexToRgba(colors.primary, 0.22)
                  : 'rgba(28, 24, 69, 0.55)',
              borderColor:
                activeTab === 'historique'
                  ? hexToRgba(colors.primary, 0.7)
                  : hexToRgba(colors.border, 0.45),
              opacity: pressed ? 0.75 : 1,
            },
          ]}
          onPress={() => setActiveTab('historique')}
        >
          <Feather
            name="bar-chart-2"
            size={20}
            color={
              activeTab === 'historique' ? colors.primary : colors.mutedForeground
            }
          />
          <View style={styles.tabLabelStack}>
            <Text
              style={[
                styles.tabText,
                {
                  color:
                    activeTab === 'historique'
                      ? colors.primary
                      : colors.foreground,
                },
              ]}
            >
              Statistiques
            </Text>
            <Text
              style={[styles.tabSubtext, { color: colors.mutedForeground }]}
            >
              Tirages & historique
            </Text>
          </View>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.tabButton,
            {
              backgroundColor:
                activeTab === 'audio'
                  ? hexToRgba(colors.accent, 0.22)
                  : 'rgba(28, 24, 69, 0.55)',
              borderColor:
                activeTab === 'audio'
                  ? hexToRgba(colors.accent, 0.7)
                  : hexToRgba(colors.border, 0.45),
              opacity: pressed ? 0.75 : 1,
            },
          ]}
          onPress={() => setActiveTab('audio')}
        >
          <Feather
            name="volume-2"
            size={20}
            color={
              activeTab === 'audio' ? colors.accent : colors.mutedForeground
            }
          />
          <View style={styles.tabLabelStack}>
            <Text
              style={[
                styles.tabText,
                {
                  color:
                    activeTab === 'audio' ? colors.accent : colors.foreground,
                },
              ]}
            >
              Dernière lecture
            </Text>
            <Text
              style={[styles.tabSubtext, { color: colors.mutedForeground }]}
            >
              Chronologie texte + TTS
            </Text>
          </View>
        </Pressable>
      </View>

      {loading || !stats ? (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loaderText, { color: colors.mutedForeground }]}>
            Chargement des statistiques…
          </Text>
        </View>
      ) : (
        <>
            <View style={styles.cardsGrid}>
              <StatCard
                title="AUJOURD’HUI"
                shortReadings={stats.today.shortReadings}
                detailReadings={stats.today.detailReadings}
                totalDraws={stats.today.totalDraws}
                creditsUsed={stats.today.creditsUsed}
                avgGenerationTimeMs={stats.today.avgGenerationTimeMs}
                accent={colors.primary}
              />
              <StatCard
                title="CETTE SEMAINE"
                shortReadings={stats.thisWeek.shortReadings}
                detailReadings={stats.thisWeek.detailReadings}
                totalDraws={stats.thisWeek.totalDraws}
                creditsUsed={stats.thisWeek.creditsUsed}
                avgGenerationTimeMs={stats.thisWeek.avgGenerationTimeMs}
                accent={colors.accent}
              />
              <StatCard
                title="DEPUIS L’INSTALLATION"
                shortReadings={stats.allTime.shortReadings}
                detailReadings={stats.allTime.detailReadings}
                totalDraws={stats.allTime.totalDraws}
                creditsUsed={stats.allTime.creditsUsed}
                avgGenerationTimeMs={stats.allTime.avgGenerationTimeMs}
                accent="#C9A84C"
              />
            </View>

            {/* Total credits and average time summary */}
            <View
              style={[
                styles.summaryCard,
                {
                  backgroundColor: 'rgba(28, 24, 69, 0.72)',
                  borderColor: hexToRgba(colors.primary, 0.35),
                },
              ]}
            >
              <View style={styles.summaryRow}>
                <View style={styles.summaryCell}>
                  <Text style={[styles.summaryValue, { color: colors.primary }]}>
                    {stats.allTime.creditsUsed}
                  </Text>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                    Crédits totaux consommés
                  </Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryCell}>
                  <Text style={[styles.summaryValue, { color: colors.primary }]}>
                    {formatTime(stats.allTime.avgGenerationTimeMs)}
                  </Text>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
                    Temps moyen de génération
                  </Text>
                </View>
              </View>
            </View>

            {activeTab === 'historique' ? (
              <View style={styles.historySection}>
                <View style={styles.historyHeader}>
                  <Text style={[styles.historyTitle, { color: colors.foreground }]}>
                    Historique chronologique
                  </Text>
                  <Text
                    style={[styles.historyCount, { color: colors.mutedForeground }]}
                  >
                    {history.length} entrée{history.length > 1 ? 's' : ''}
                  </Text>
                </View>

                {history.length === 0 ? (
                  <View
                    style={[
                      styles.emptyHistory,
                      {
                        backgroundColor: 'rgba(28, 24, 69, 0.55)',
                        borderColor: hexToRgba(colors.border, 0.5),
                      },
                    ]}
                  >
                    <Feather name="inbox" size={24} color={colors.mutedForeground} />
                    <Text
                      style={[
                        styles.emptyHistoryText,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Aucune utilisation enregistrée pour l’instant.
                    </Text>
                  </View>
                ) : (
                  history.map((event, index) => (
                    <HistoryItem
                      key={event.id}
                      event={event}
                      index={index}
                      colors={colors}
                    />
                  ))
                )}
              </View>
            ) : (
              /* Audio TTS panel */
              <LastReadingSection
                stats={audioStats}
                lastError={audioLastError}
                onRefresh={refreshAudioStats}
              />
            )}

            {/* Clear data */}
            <Pressable
              style={({ pressed }) => [
                styles.clearButton,
                {
                  backgroundColor: pressed ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                  borderColor: colors.destructive,
                },
              ]}
              onPress={handleClear}
            >
              <Feather name="trash-2" size={16} color={colors.destructive} />
              <Text style={[styles.clearButtonText, { color: colors.destructive }]}>
                Réinitialiser les statistiques
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
  );
}

export default function AdminScreen() {
  const router = useRouter();
  const { isAdminUnlocked, lockAdmin } = useAdminAccess();
  const [authenticated, setAuthenticated] = useState(isAdminAuthenticated());

  useEffect(() => {
    if (!isAdminUnlocked) {
      router.replace('/');
    }
  }, [isAdminUnlocked, router]);

  return (
    <ImageBackground source={TAROT_BG} style={styles.container} resizeMode="cover">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10, 8, 21, 0.6)' }]} />
      {authenticated ? (
        <AdminDashboard />
      ) : (
        <AdminLoginGate onAuthenticated={() => setAuthenticated(true)} />
      )}
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loginContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  loginCard: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    gap: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(16, 14, 42, 0.75)',
    padding: 28,
  },
  loginTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    letterSpacing: 1,
  },
  loginSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  loginInput: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  loginError: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    textAlign: 'center',
  },
  loginButton: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginButtonText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  scrollContent: {
    paddingHorizontal: 20,
    gap: 20,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  backButtonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  screenTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  headerSpacer: {
    width: 70,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginTop: -12,
    marginBottom: 4,
  },

  loader: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
    gap: 16,
  },
  loaderText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },

  cardsGrid: {
    gap: 16,
  },
  statCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  statCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statCardTitle: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
  },
  statRow: {
    flexDirection: 'row',
    gap: 12,
  },
  statCell: {
    flex: 1,
    gap: 4,
  },
  statValue: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
  },
  statLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  statFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  statFooterText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },

  summaryCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryCell: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  summaryDivider: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  summaryValue: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
  },
  summaryLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },

  historySection: {
    gap: 12,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  historyTitle: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  historyCount: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  historyItem: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  historyIndex: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    width: 30,
  },
  historyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  historyBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  historyCredits: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    marginLeft: 'auto',
  },
  historyQuestion: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 20,
  },
  historyDate: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  emptyHistory: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
  },
  emptyHistoryText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },

  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 8,
  },
  clearButtonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },

  // Audio section
  audioSection: {
    gap: 12,
  },
  audioSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  audioSectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  audioSectionTitle: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  audioRefreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  audioRefreshText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
  },
  audioErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  audioErrorText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  audioQuotaCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  audioQuotaHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  audioQuotaTexts: {
    flex: 1,
    gap: 4,
  },
  audioQuotaLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  audioQuotaValue: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  audioQuotaPercent: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  audioMeterTrack: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  audioMeterFill: {
    height: '100%',
    borderRadius: 4,
  },
  audioQuotaFooter: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  audioLoadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 10,
  },
  audioLoadingText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  audioStatGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  audioStatCell: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  audioStatValue: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  audioStatLabel: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  audioClientMetricBox: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 5,
  },
  audioClientMetricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  audioClientMetricTitle: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.8,
  },
  timelineLine: {
    fontSize: 13,
    lineHeight: 21,
    fontFamily: 'Inter_400Regular',
  },
  audioClientMetricValue: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
  },
  audioClientMetricDescription: {
    fontSize: 10,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
  },
  audioList: {
    gap: 8,
  },
  audioListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  audioListTitle: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  audioListCount: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  audioItem: {
    padding: 10,
    gap: 6,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderWidth: 1,
  },
  audioItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  audioItemSource: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  audioItemChars: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    marginLeft: 'auto',
  },
  audioItemPreview: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 17,
  },
  audioItemHint: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  audioItemReason: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  audioDailyCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  audioDailyTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  audioDailyPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  audioDailyPill: {
    flex: 1,
    minWidth: 120,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'flex-start',
  },
  audioDailyPillDisabled: {
    opacity: 0.55,
  },
  audioDailyPillLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  audioDailyPillValue: {
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  audioDailyPillDate: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.3,
  },
  audioDailyNote: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    lineHeight: 14,
  },
  audioEmpty: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    paddingVertical: 12,
  },
  audioClearButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  audioClearText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Page selector tabs
  tabBar: {
    flexDirection: 'row',
    gap: 12,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  tabLabelStack: {
    flex: 1,
    gap: 2,
  },
  tabText: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  tabSubtext: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
});
