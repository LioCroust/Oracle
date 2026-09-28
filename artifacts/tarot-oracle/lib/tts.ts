// Text-to-Speech helper.
//
// Primary strategy: ask the server's /tarot/reading/tts endpoint, which calls
// Gemini's flash TTS model (voice: Kore, FR, conversationnel). Native playback
// stays at the natural 1x rate after decoding each streamed segment.
// returns a 24 kHz mono WAV (raw PCM wrapped in a minimal WAV header).
//
// Fallback strategy: when the server reports 429 (monthly Gemini quota
// exhausted) or 502 (any upstream failure), we delegate to expo-speech
// (Android/iOS native TTS engines) on native, and the Web Speech API on web.
// Both honor `language: 'fr-FR'` and a calm natural rate.
//
// Usage is tracked (chars used this month vs the 1M-char free tier) and shared
// with the UI via subscribeTtsUsage(). Each playback is appended to a local
// "audio log" (last 50) and broadcast via subscribeAudioLog(). The server
// keeps its own authoritative audio log exposed at /tarot/reading/tts/stats
// for the admin dashboard.
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { DEFAULT_VOICE, type StudioVoice } from '@/lib/ttsVoices';
import { getSelectedVoiceSync } from '@/lib/voiceStorage';

// Helper used by every fetch below — reads the currently selected studio
// voice from the voice picker. Synced because tts.ts is called from
// non-React contexts (audio playback, prefetches); the picker writes to
// the same in-memory cache via setSelectedVoice().
function currentVoice(): StudioVoice {
  return getSelectedVoiceSync();
}

// Base URL shared with @workspace/api-client-react (set in _layout.tsx).
const apiBaseUrl = process.env.EXPO_PUBLIC_DOMAIN ?? '';
const TTS_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/tts`;
const TTS_STREAM_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/tts/stream`;
const TTS_ANDROID_STREAM_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/tts/android-stream`;
const TTS_STATS_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/tts/stats`;
const TTS_CLIENT_METRICS_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/tts/client-metrics`;

const TTS_MONTHLY_LIMIT = 1_000_000;
// Keep generated PCM and expo-speech fallback on the same explicit natural
// speed. A named constant makes accidental per-path drift easier to spot.
const TTS_PLAYBACK_RATE = 1;
const NATIVE_SPEECH_PITCH = 0.96;
// Gemini TTS commonly takes 10–20 seconds on a cold request. Resolving
// earlier makes AudioButton report "no audio" while the WAV is still being
// generated, so the user hears nothing on the first tap.
const GEMINI_FIRST_TIMEOUT_MS = 45_000;

export const TTS_VOICE = DEFAULT_VOICE;

// ─── Quota-exhaustion tracker ────────────────────────────────────────────────
// Fall back to expo-speech *only* when Gemini is proven unreachable — i.e.
// when the server returned HTTP 429. A 60-second grace window keeps a
// stale 429 from triggering fallback after recovery. Slow networks, time-
// outs, transient fetch errors all reach this branch without setting the
// flag, so the next speakText() keeps preferring Gemini.
let lastQuotaExhaustedAt = 0;
function noteQuotaExhausted() {
  lastQuotaExhaustedAt = Date.now();
}
export function isQuotaExhausted(): boolean {
  return Date.now() - lastQuotaExhaustedAt < 60_000;
}
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// ─── Shared state (one active playback at a time across all buttons) ──────────
let currentPlayer: AudioPlayer | null = null;
let currentTempFile: string | null = null;
let currentBlobUrl: string | null = null;
let currentStreamAbortController: AbortController | null = null;
let currentStreamEndTimer: ReturnType<typeof setTimeout> | null = null;
let currentNativeSegmentStop: (() => void) | null = null;
let streamGeneration = 0;
let speakRequestId = 0;
interface NativeTextJob {
  text: string;
  controller: AbortController;
  prefetchedPcm: Promise<Uint8Array[]> | null;
  requestId: number;
  queueRunId: number;
  isFirstInRun: boolean;
}

let queuedNativeJobs: NativeTextJob[] = [];
let nativeTextQueueRunning = false;
let nativeTextQueueStartScheduled = false;
let nativeTextQueueRunId = 0;
const queuedNativeTextKeys = new Set<string>();
const nativePrefetchControllers = new Set<AbortController>();
const nativePrefetchControllerKeys = new Map<AbortController, string>();
const currentStreamSources = new Set<AudioBufferSourceNode>();
let speechActive = false;
let nativeSpeechRunId = 0;
let standaloneTtsActive = false;
const oracleReadyAtByKey = new Map<string, number>();
const prefetchTimingByKey = new Map<
  string,
  { startedAt: number; completedAt?: number }
>();

export type TtsStatus = 'idle' | 'loading' | 'playing' | 'speaking' | 'error';
export interface TtsPlaybackSnapshot {
  active: boolean;
  durationMs: number;
  text?: string;
}
const playbackListeners = new Set<(snapshot: TtsPlaybackSnapshot) => void>();
let lastPlayback: TtsPlaybackSnapshot = { active: false, durationMs: 0 };

function publishPlayback(snapshot: TtsPlaybackSnapshot) {
  lastPlayback = snapshot;
  if (!snapshot.active) standaloneTtsActive = false;
  playbackListeners.forEach((listener) => listener(snapshot));
}

export function subscribeTtsPlayback(
  listener: (snapshot: TtsPlaybackSnapshot) => void,
): () => void {
  playbackListeners.add(listener);
  listener(lastPlayback);
  return () => playbackListeners.delete(listener);
}

export function markOracleReady(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  oracleReadyAtByKey.set(cacheKey(trimmed), Date.now());
  while (oracleReadyAtByKey.size > 20) {
    const oldestKey = oracleReadyAtByKey.keys().next().value;
    if (oldestKey === undefined) break;
    oracleReadyAtByKey.delete(oldestKey);
  }
}

function reportOracleFirstAudio(
  text: string,
  source: 'gemini' | 'expo-speech',
  cacheHit: boolean,
): void {
  const trimmed = text.trim();
  const key = cacheKey(trimmed);
  const oracleReadyAt = oracleReadyAtByKey.get(key);
  if (!oracleReadyAt) return;
  oracleReadyAtByKey.delete(key);
  const prep = prefetchTimingByKey.get(key);
  const preparationMs =
    prep?.completedAt !== undefined
      ? Math.max(0, prep.completedAt - prep.startedAt)
      : undefined;
  void expoFetch(TTS_CLIENT_METRICS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chars: trimmed.length,
      textPreview: trimmed,
      oracleToFirstAudioMs: Math.max(0, Date.now() - oracleReadyAt),
      preparationMs,
      cacheHit,
      source,
    }),
  }).catch(() => undefined);
}

function wavDurationMs(base64: string): number {
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const source = base64.replace(/[^A-Za-z0-9+/=]/g, '');
    const bytes = new Uint8Array(Math.floor((source.length * 3) / 4));
    let output = 0;
    for (let i = 0; i < source.length; i += 4) {
      const a = alphabet.indexOf(source[i]);
      const b = alphabet.indexOf(source[i + 1]);
      const c = alphabet.indexOf(source[i + 2]);
      const d = alphabet.indexOf(source[i + 3]);
      if (a < 0 || b < 0) break;
      bytes[output++] = (a << 2) | (b >> 4);
      if (source[i + 2] !== '=' && c >= 0) bytes[output++] = ((b & 15) << 4) | (c >> 2);
      if (source[i + 3] !== '=' && c >= 0 && d >= 0) bytes[output++] = ((c & 3) << 6) | d;
    }
    const view = new DataView(bytes.buffer);
    const sampleRate = view.getUint32(24, true);
    const channels = view.getUint16(22, true);
    const bitsPerSample = view.getUint16(34, true);
    if (!sampleRate || !channels || !bitsPerSample) return 0;
    let dataOffset = -1;
    for (let i = 12; i + 8 <= output; i += 1) {
      if (bytes[i] === 100 && bytes[i + 1] === 97 && bytes[i + 2] === 116 && bytes[i + 3] === 97) {
        dataOffset = i;
        break;
      }
    }
    if (dataOffset < 0 || dataOffset + 8 > bytes.length) return 0;
    const dataBytes = view.getUint32(dataOffset + 4, true);
    return Math.max(1000, Math.round((dataBytes / (sampleRate * channels * (bitsPerSample / 8))) * 1000));
  } catch {
    return 0;
  }
}

export interface TtsUsageSnapshot {
  charsUsed: number;
  charsLimit: number;
  // Mirrors the Gemini SDK's `usageMetadata` so the admin "stats token tts"
  // counter matches what's displayed on AI Studio (input vs output tokens).
  inputTokens: number;
  outputTokens: number;
  voice: string;
  model: string;
}

const usageListeners = new Set<(s: TtsUsageSnapshot) => void>();
let lastUsage: TtsUsageSnapshot = {
  charsUsed: 0,
  charsLimit: TTS_MONTHLY_LIMIT,
  inputTokens: 0,
  outputTokens: 0,
  voice: TTS_VOICE,
  model: TTS_MODEL,
};

function publishUsage(patch: Partial<TtsUsageSnapshot>) {
  lastUsage = { ...lastUsage, ...patch };
  for (const l of usageListeners) l(lastUsage);
}

export function getTtsUsage(): TtsUsageSnapshot {
  return lastUsage;
}

export function subscribeTtsUsage(
  listener: (s: TtsUsageSnapshot) => void,
): () => void {
  usageListeners.add(listener);
  listener(lastUsage);
  return () => {
    usageListeners.delete(listener);
  };
}

// ─── Local audio log (last N plays, used by the admin dashboard) ──────────────
export interface AudioLogEntry {
  id: string;
  timestamp: number;
  textPreview: string;
  chars: number;
  source: 'gemini' | 'expo-speech';
  fallback: boolean;
  latencyMs: number;
  cacheHit: boolean;
  // Free-form operator hint — set to "timeout" when Gemini TTS didn't
  // return a WAV within the patience window and we resolved silently, or
  // "quota" when the fallback was forced because the server replied 429.
  reason?: string;
}

const AUDIO_LOG_LIMIT = 50;
const audioLog: AudioLogEntry[] = [];
const audioLogListeners = new Set<(log: AudioLogEntry[]) => void>();

function logAudio(entry: AudioLogEntry) {
  audioLog.unshift(entry);
  if (audioLog.length > AUDIO_LOG_LIMIT) audioLog.length = AUDIO_LOG_LIMIT;
  const snapshot = audioLog.slice();
  for (const l of audioLogListeners) l(snapshot);
}

export function getAudioLog(): AudioLogEntry[] {
  return audioLog.slice();
}

export function subscribeAudioLog(
  listener: (log: AudioLogEntry[]) => void,
): () => void {
  audioLogListeners.add(listener);
  listener(audioLog.slice());
  return () => {
    audioLogListeners.delete(listener);
  };
}

export function clearAudioLog(): void {
  audioLog.length = 0;
  for (const l of audioLogListeners) l(audioLog.slice());
}

// ─── Audio prep state (consumed by AudioButton to show "ready" badge) ─────────
export type TtsPrepStatus = 'idle' | 'pending' | 'ready' | 'error';
const prepState = new Map<string, TtsPrepStatus>();
const prepListeners = new Set<() => void>();

function setPrep(key: string, status: TtsPrepStatus) {
  prepState.set(key, status);
  for (const l of prepListeners) l();
}

export function getTtsPrepStatus(text: string): TtsPrepStatus {
  const key = cacheKey(text.trim());
  if (audioCache.has(key) || getNativePcmForText(text.trim())) return 'ready';
  return prepState.get(key) ?? 'idle';
}

export function isTtsCached(text: string): boolean {
  return audioCache.has(cacheKey(text.trim())) || Boolean(getNativePcmForText(text.trim()));
}

export function subscribeTtsPrep(listener: () => void): () => void {
  prepListeners.add(listener);
  return () => {
    prepListeners.delete(listener);
  };
}

// ─── Stop everything currently playing ────────────────────────────────────────
async function stopTtsInternal(
  preserveNativeStreamKey?: string,
  preserveNativeWarmupKey?: string,
): Promise<void> {
  streamGeneration += 1;
  nativeTextQueueRunId += 1;
  nativeSpeechRunId += 1;
  queuedNativeJobs = [];
  queuedNativeTextKeys.clear();
  for (const [key, warmup] of nativeTtsWarmups) {
    if (key !== preserveNativeWarmupKey) {
      warmup.cancelled = true;
      nativeTtsWarmups.delete(key);
    }
  }
  const preservedWarmup = preserveNativeWarmupKey
    ? nativeTtsWarmups.get(preserveNativeWarmupKey)
    : undefined;
  const preservedWarmupSentenceKeys = new Set(
    preservedWarmup?.sentences.map((sentence) => cacheKey(sentence)) ?? [],
  );
  for (const controller of nativePrefetchControllers) {
    const controllerKey = nativePrefetchControllerKeys.get(controller);
    if (!preservedWarmupSentenceKeys.has(controllerKey ?? '')) {
      controller.abort();
    }
  }
  for (const session of nativeStreamSessions.values()) {
    if (session.key === preserveNativeStreamKey && !session.consumed) continue;
    session.controller.abort();
    session.wakeConsumer?.();
  }
  for (const [key, session] of nativeStreamSessions) {
    if (key !== preserveNativeStreamKey || session.consumed) {
      nativeStreamSessions.delete(key);
    }
  }
  if (
    currentStreamAbortController &&
    (!preserveNativeStreamKey ||
      [...nativeStreamSessions.values()].every(
        (session) => session.controller !== currentStreamAbortController,
      ))
  ) {
    currentStreamAbortController.abort();
    currentStreamAbortController = null;
  }
  currentNativeSegmentStop?.();
  currentNativeSegmentStop = null;
  if (currentStreamEndTimer) {
    clearTimeout(currentStreamEndTimer);
    currentStreamEndTimer = null;
  }
  for (const source of currentStreamSources) {
    try {
      source.stop();
    } catch {
      // The source may already have ended.
    }
    source.disconnect();
  }
  currentStreamSources.clear();
  publishPlayback({ active: false, durationMs: 0 });

  try {
    currentPlayer?.pause();
  } catch {
    // ignore: the player may already be released when shared across components
  }
  currentPlayer = null;

  try {
    await Speech.stop();
  } catch {
    // ignore: Speech.stop throws on web if no utterance is queued
  }
  speechActive = false;

  if (currentBlobUrl) {
    try {
      URL.revokeObjectURL(currentBlobUrl);
    } catch {
      // web-only
    }
    currentBlobUrl = null;
  }

  if (currentTempFile) {
    try {
      await FileSystem.deleteAsync(currentTempFile, { idempotent: true });
    } catch {
      // ignore: file may already be gone
    }
    currentTempFile = null;
  }
}

export async function stopTts(): Promise<void> {
  speakRequestId += 1;
  await stopTtsInternal();
}

// ─── Native / web audio file plumbing ─────────────────────────────────────────
function base64ToBytes(b64: string): Uint8Array {
  const binary =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extractPcmFromWav(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, value: string) =>
    value.split('').every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (!ascii(0, 'RIFF') || !ascii(8, 'WAVE')) return null;

  let offset = 12;
  let formatOk = false;
  while (offset + 8 <= bytes.length) {
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = Math.min(bytes.length, dataStart + chunkSize);
    if (ascii(offset, 'fmt ') && dataEnd - dataStart >= 16) {
      const audioFormat = view.getUint16(dataStart, true);
      const channels = view.getUint16(dataStart + 2, true);
      const sampleRate = view.getUint32(dataStart + 4, true);
      const bitsPerSample = view.getUint16(dataStart + 14, true);
      formatOk =
        audioFormat === 1 &&
        channels === 1 &&
        sampleRate === STREAM_SAMPLE_RATE &&
        bitsPerSample === 16;
    }
    if (ascii(offset, 'data')) {
      if (!formatOk) return null;
      // PCM16 must end on a complete sample. Drop a possible provider padding
      // byte instead of sending it to Android's decoder as audible garbage.
      const pcmLength = Math.min(chunkSize, bytes.length - dataStart) & ~1;
      return pcmLength > 0 ? bytes.slice(dataStart, dataStart + pcmLength) : null;
    }
    offset = dataStart + chunkSize + (chunkSize & 1);
  }
  return null;
}

interface TempAudioSource {
  uri: string;
  cleanup: () => Promise<void>;
}

async function writeTempWav(b64: string): Promise<TempAudioSource> {
  if (Platform.OS === 'web') {
    const bytes = base64ToBytes(b64);
    const freshBuffer = new Uint8Array(bytes);
    const blob = new Blob([freshBuffer.buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    currentBlobUrl = url;
    return {
      uri: url,
      cleanup: async () => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
        if (currentBlobUrl === url) currentBlobUrl = null;
      },
    };
  }
  const fileUri = `${FileSystem.cacheDirectory ?? ''}tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`;
  await FileSystem.writeAsStringAsync(fileUri, b64, { encoding: 'base64' });
  currentTempFile = fileUri;
  return {
    uri: fileUri,
    cleanup: async () => {
      try {
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
      } catch {
        // ignore
      }
      if (currentTempFile === fileUri) currentTempFile = null;
    },
  };
}

// ─── LRU cache so the same snippet is instant on replay ───────────────────────
interface CacheEntry {
  audioBase64: string;
  chars: number;
  charsUsed: number;
  charsLimit: number;
  inputTokens: number;
  outputTokens: number;
  voice: string;
  model: string;
}
const AUDIO_CACHE_LIMIT = 5;
const audioCache = new Map<string, CacheEntry>();
const nativePcmCache = new Map<string, Uint8Array[]>();
const nativePcmChunkTexts = new Map<string, string[]>();
// Keep a seekable local WAV beside the in-memory PCM cache. Android's player
// still needs a file, but replaying this stable file avoids rebuilding and
// rewriting the whole WAV on every tap.
const nativeWavFileCache = new Map<string, string>();
const nativeWavFilePromises = new Map<string, Promise<string | undefined>>();

interface NativeTtsWarmup {
  key: string;
  text: string;
  sentences: string[];
  sentenceAudio: Promise<Uint8Array[]>[];
  cancelled: boolean;
  playbackStarted?: boolean;
}

// A warmup starts short, sentence-sized Gemini TTS requests while the cards
// are still animating. No player is opened until speakText() consumes this
// prepared run after the Oracle is revealed.
const nativeTtsWarmups = new Map<string, NativeTtsWarmup>();
const MAX_EARLY_TTS_REQUESTS = 4;

function cacheKey(text: string): string {
  return `${currentVoice()}|${TTS_MODEL}|${text}`;
}

function stableFileHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = audioCache.get(key);
  if (entry) {
    audioCache.delete(key);
    audioCache.set(key, entry); // refresh recency
  }
  return entry;
}

function cachePut(key: string, entry: CacheEntry) {
  audioCache.set(key, entry);
  while (audioCache.size > AUDIO_CACHE_LIMIT) {
    const oldestKey = audioCache.keys().next().value;
    if (oldestKey === undefined) break;
    audioCache.delete(oldestKey);
  }
}

function cacheDelete(key: string) {
  audioCache.delete(key);
}

function nativePcmCacheGet(key: string): Uint8Array[] | undefined {
  const segments = nativePcmCache.get(key);
  if (!segments) return undefined;
  nativePcmCache.delete(key);
  nativePcmCache.set(key, segments);
  return segments.map((segment) => segment.slice());
}

function nativePcmCachePut(key: string, segments: Uint8Array[]): void {
  if (segments.length === 0) return;
  const normalizedSegments = segments
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.slice());
  nativePcmChunkTexts.delete(key);
  nativePcmCache.delete(key);
  nativePcmCache.set(
    key,
    normalizedSegments,
  );
  while (nativePcmCache.size > AUDIO_CACHE_LIMIT) {
    const oldestKey = nativePcmCache.keys().next().value;
    if (oldestKey === undefined) break;
    nativePcmCache.delete(oldestKey);
    nativePcmChunkTexts.delete(oldestKey);
  }
  setPrep(key, 'ready');
  void ensureNativeWavFile(key, normalizedSegments);
}

async function ensureNativeWavFile(
  key: string,
  segments: Uint8Array[],
): Promise<string | undefined> {
  const cached = nativeWavFileCache.get(key);
  if (cached) return cached;
  const existing = nativeWavFilePromises.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const fileUri = `${FileSystem.cacheDirectory ?? ''}tts-cache-${stableFileHash(key)}.wav`;
      const info = await FileSystem.getInfoAsync(fileUri);
      if (!info.exists) {
        const pcm = segments.reduce(
          (combined, segment) => concatBytes(combined, segment),
          new Uint8Array(0),
        );
        if (pcm.length === 0) return undefined;
        const wav = concatBytes(wavHeaderBytes(pcm.length), pcm);
        await FileSystem.writeAsStringAsync(fileUri, bytesToBase64(wav), {
          encoding: 'base64',
        });
      }
      nativeWavFileCache.set(key, fileUri);
      return fileUri;
    } catch {
      // The PCM cache remains a valid fallback when local file persistence is
      // unavailable on a particular Expo runtime.
      return undefined;
    } finally {
      nativeWavFilePromises.delete(key);
    }
  })();
  nativeWavFilePromises.set(key, promise);
  return promise;
}

function splitTtsSentences(value: string): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let start = 0;
  let index = 0;
  const isPunctuation = (char: string) => /[.!?…]/.test(char);
  const isClosingMark = (char: string) => /["'»”’)\]}]/.test(char);

  // Keep every character while only committing a chunk after sentence
  // punctuation. Closing French quotes/brackets stay attached to that
  // sentence, so they cannot cause the following sentence to be dropped.
  while (index < normalized.length) {
    if (!isPunctuation(normalized[index])) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < normalized.length && isPunctuation(normalized[end])) end += 1;
    while (end < normalized.length && isClosingMark(normalized[end])) end += 1;

    if (end === normalized.length || /\s/.test(normalized[end])) {
      const sentence = normalized.slice(start, end).trim();
      if (sentence) chunks.push(sentence);
      while (end < normalized.length && /\s/.test(normalized[end])) end += 1;
      start = end;
      index = end;
    } else {
      // Decimal numbers and abbreviations are not sentence boundaries.
      index += 1;
    }
  }

  const remainder = normalized.slice(start).trim();
  if (remainder) chunks.push(remainder);
  return chunks;
}

function splitTtsChunks(value: string): string[] {
  return splitTtsSentences(value);
}

function normalizeTtsText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitCompleteTtsSentences(value: string): string[] {
  return (
    value
      .match(/[^.!?…]+[.!?…]+(?:\s+|$)/g)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

function ensureWarmupSentences(
  warmup: NativeTtsWarmup,
  sentences: string[],
): void {
  let candidates = sentences;
  const existingText = normalizeTtsText(warmup.sentences.join(' '));
  const incomingText = normalizeTtsText(candidates.join(' '));
  if (existingText && incomingText) {
    if (incomingText.startsWith(existingText)) {
       // The stream grows cumulatively. Keep every already prepared sentence
       // and synthesize only the new suffix.
      const remainder = incomingText.slice(existingText.length).trim();
      candidates = remainder ? splitTtsChunks(remainder) : [];
    } else if (existingText.startsWith(incomingText)) {
      // A shorter SSE update contains no new audio to queue.
      candidates = [];
    }
  }
  const known = new Set(warmup.sentences.map(normalizeTtsText));
  for (const sentence of candidates) {
    const normalized = normalizeTtsText(sentence);
    if (normalized && !known.has(normalized)) {
      warmup.sentences.push(sentence);
      known.add(normalized);
    }
  }
  // During the text stream, keep warming newly completed blocks so the
  // synthesis does not stall after only the first two requests. Once playback
  // has started, return to the one-request-ahead behavior to avoid a burst.
  const requestLimit = warmup.playbackStarted ? 2 : MAX_EARLY_TTS_REQUESTS;
  const requestCount = Math.min(requestLimit, warmup.sentences.length);
  for (let index = 0; index < requestCount; index += 1) {
    if (!warmup.sentenceAudio[index]) {
      warmup.sentenceAudio[index] = startSentencePrefetch(warmup.sentences[index]);
    }
  }
}

function findNativeTtsWarmup(text: string): NativeTtsWarmup | undefined {
  const exact = nativeTtsWarmups.get(cacheKey(text.trim()));
  if (exact) return exact;
  const firstSentence = splitTtsChunks(text)[0];
  return firstSentence
    ? nativeTtsWarmups.get(cacheKey(firstSentence))
    : undefined;
}

function startNativeTtsWarmup(
  text: string,
  sentences: string[],
): NativeTtsWarmup | null {
  const firstSentence = sentences[0];
  if (!firstSentence) return null;
  const existing = findNativeTtsWarmup(text);
  if (existing) {
    existing.text = text;
    ensureWarmupSentences(existing, sentences);
    return existing;
  }

  const warmup: NativeTtsWarmup = {
    // Index by the first stable sentence so a later, longer SSE fragment can
    // take over the same warmup before the final reading text is known.
    key: cacheKey(firstSentence),
    text,
    sentences: [],
    sentenceAudio: [],
    cancelled: false,
  };
  nativeTtsWarmups.set(warmup.key, warmup);
  ensureWarmupSentences(warmup, sentences);
  setPrep(cacheKey(text), 'pending');
  return warmup;
}

function getNativePcmForText(text: string): Uint8Array[] | undefined {
  // Never rebuild a reading from sentence caches. Each sentence is a
  // separately synthesized asset and joining those assets at playback time is
  // exactly what caused the pauses and occasional clicks. Only a complete
  // reading cache is eligible for one-player playback.
  return nativePcmCacheGet(cacheKey(text));
}

async function waitForAudioCache(
  key: string,
  timeoutMs: number,
): Promise<CacheEntry | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = cacheGet(key);
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return cacheGet(key);
}

// ─── Fallback: native Speech / Web Speech API ─────────────────────────────────
async function speakWithNativeTts(
  text: string,
  waitForCompletion = false,
  releasesStandaloneLock = false,
): Promise<void> {
  const runId = ++nativeSpeechRunId;
  await Speech.stop();
  if (runId !== nativeSpeechRunId) return;
  speechActive = true;
  publishPlayback({
    active: true,
    durationMs: Math.max(1000, text.length * 65),
    text,
  });
  let finished = false;
  let finishSpeech: (() => void) | null = null;
  const completion = new Promise<void>((resolve) => {
    finishSpeech = resolve;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    if (runId === nativeSpeechRunId) {
      speechActive = false;
      if (releasesStandaloneLock) standaloneTtsActive = false;
      publishPlayback({ active: false, durationMs: 0 });
    }
    finishSpeech?.();
  };

  try {
    Speech.speak(text, {
      language: 'fr-FR',
      pitch: NATIVE_SPEECH_PITCH,
      rate: TTS_PLAYBACK_RATE,
      onStart: () => {
        if (runId === nativeSpeechRunId) speechActive = true;
      },
      onDone: finish,
      onStopped: finish,
      onError: finish,
    });
  } catch {
    finish();
  }

  // The public standalone path keeps its existing "started" timing, while
  // progressive queue fallbacks opt into waiting for the real native end
  // callback before allowing Gemini to open the next player.
  if (waitForCompletion) {
    const safetyTimeout = setTimeout(
      finish,
      Math.max(10_000, text.length * 80 + 5_000),
    );
    await completion;
    clearTimeout(safetyTimeout);
  }
}

// Play a WAV payload that's already in memory as base64. Runs the temp-file
// write and the audio-mode probe concurrently so we don't pay them serially.
async function playBase64Wav(audioBase64: string): Promise<TempAudioSource> {
  const [{ uri, cleanup }] = await Promise.all([
    writeTempWav(audioBase64),
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined),
  ]);
  const player = createAudioPlayer({ uri });
  currentPlayer = player;
  const durationMs = wavDurationMs(audioBase64);
  const loaded = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Native audio player did not load the WAV.'));
    }, 8_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    player.addListener('playbackStatusUpdate', (status) => {
      if (status.isLoaded) finish();
      if (status.didJustFinish) {
        if (currentPlayer === player) currentPlayer = null;
        publishPlayback({ active: false, durationMs: 0 });
        cleanup().catch(() => undefined);
      }
    });
    if (player.isLoaded) finish();
  });
  try {
    await loaded;
  } catch (error) {
    if (currentPlayer === player) currentPlayer = null;
    try {
      player.pause();
    } catch {
      // ignore
    }
    await cleanup();
    throw error;
  }
  if (TTS_PLAYBACK_RATE !== 1) {
    player.setPlaybackRate(TTS_PLAYBACK_RATE);
  }
  publishPlayback({ active: true, durationMs });
  player.play();
  return { uri, cleanup };
}

function wavHeaderBytes(pcmLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const ascii = (value: string, offset: number) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
  };
  ascii('RIFF', 0);
  view.setUint32(4, 36 + pcmLength, true);
  ascii('WAVE', 8);
  ascii('fmt ', 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, STREAM_SAMPLE_RATE, true);
  view.setUint32(28, STREAM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii('data', 36);
  view.setUint32(40, pcmLength, true);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
}

async function writePcmSegment(pcm: Uint8Array): Promise<TempAudioSource> {
  const wav = concatBytes(wavHeaderBytes(pcm.length), pcm);
  return writeTempWav(bytesToBase64(wav));
}

async function playNativePcmSegment(
  pcm: Uint8Array,
  generation: number,
  onFirstAudio: () => void,
  text?: string,
  existingUri?: string,
  sharedPlayer?: AudioPlayer,
  retainPlayer = false,
): Promise<AudioPlayer | null> {
  if (generation !== streamGeneration) return null;
  const ownsPlayer = !sharedPlayer;
  const keepPlayer = retainPlayer || Boolean(sharedPlayer);
  const { uri, cleanup } = existingUri
    ? { uri: existingUri, cleanup: async () => undefined }
    : await writePcmSegment(pcm);
  if (generation !== streamGeneration) {
    await cleanup();
    return null;
  }
  const player = sharedPlayer ?? createAudioPlayer({ uri });
  if (sharedPlayer) {
    player.replace({ uri });
  }
  currentPlayer = player;
  const sourceDurationMs = Math.max(
    100,
    Math.round((pcm.length / (STREAM_SAMPLE_RATE * 2)) * 1000),
  );
  const durationMs = Math.max(100, Math.round(sourceDurationMs / TTS_PLAYBACK_RATE));

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Android audio segment did not load.'));
        }
      }, 8_000);
      const finishLoad = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      player.addListener('playbackStatusUpdate', (status) => {
       if (status.isLoaded) finishLoad();
      });
      if (ownsPlayer && player.isLoaded) finishLoad();
    });

    if (generation !== streamGeneration) return null;
    // Keep the native decoder at its natural rate. Pitch-correction
    // processing at exactly 1× is unnecessary and can introduce a click on
    // some Android audio paths.
    if (TTS_PLAYBACK_RATE !== 1) {
      player.setPlaybackRate(TTS_PLAYBACK_RATE);
    }
    publishPlayback({ active: true, durationMs, text });

    await new Promise<void>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        currentNativeSegmentStop = null;
        resolve();
      };
      currentNativeSegmentStop = finish;
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) finish();
      });
      timer = setTimeout(finish, durationMs + 2_000);
      player.play();
      // Measure after handing the complete WAV to the native player. This is
      // the closest reliable signal to the first audible sample without
      // reintroducing per-frame polling on Android.
      onFirstAudio();
    });
  } finally {
    if (ownsPlayer && !keepPlayer) {
      if (currentPlayer === player) currentPlayer = null;
      try {
        player.remove();
      } catch {
        // ignore
      }
    }
    await cleanup();
  }
  return keepPlayer ? player : null;
}

async function prefetchNativeTts(
  text: string,
  controller: AbortController,
  controllerSet: Set<AbortController> = nativePrefetchControllers,
): Promise<Uint8Array[]> {
  controllerSet.add(controller);
  nativePrefetchControllerKeys.set(controller, cacheKey(text.trim()));
  setPrep(cacheKey(text.trim()), 'pending');
  const timeout = setTimeout(() => controller.abort(), GEMINI_FIRST_TIMEOUT_MS);
  try {
    const response = await expoFetch(TTS_ANDROID_STREAM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ text, voice: currentVoice() }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      if (response.status === 429) noteQuotaExhausted();
      throw new Error(`TTS native prefetch unavailable (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pcmSegments: Uint8Array[] = [];

    const consume = (chunk: string) => {
      buffer += chunk;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        let event = '';
        let data = '';
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (event !== 'audio' || !data) continue;
        try {
          const parsed = JSON.parse(data) as { audioBase64?: string };
          if (!parsed.audioBase64) continue;
           const wav = base64ToBytes(parsed.audioBase64);
           const pcm = extractPcmFromWav(wav);
           if (pcm) pcmSegments.push(pcm);
        } catch {
          // Keep consuming later valid SSE frames.
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    if (pcmSegments.length === 0) {
      throw new Error('Native TTS prefetch contained no audio.');
    }
    return pcmSegments;
  } finally {
    clearTimeout(timeout);
    controllerSet.delete(controller);
    nativePrefetchControllerKeys.delete(controller);
  }
}

async function streamNativeTts(
  text: string,
  onComplete?: () => void,
  publishIdle = true,
): Promise<SpeakResult> {
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
  const generation = ++streamGeneration;
  const abortController = new AbortController();
  currentStreamAbortController = abortController;
  const startedAt = Date.now();
  let streamDone = false;
  let streamError: Error | null = null;
  let wakeConsumer: (() => void) | null = null;
  const queue: Uint8Array[] = [];
  const collectedSegments: Uint8Array[] = [];

  const wake = () => {
    wakeConsumer?.();
    wakeConsumer = null;
  };
  const push = (pcm: Uint8Array) => {
    const alignedLength = pcm.length & ~1;
    if (alignedLength <= 0) return;
    const aligned = pcm.slice(0, alignedLength);
    queue.push(aligned);
    collectedSegments.push(aligned.slice());
    wake();
  };
  const nextSegment = async (): Promise<Uint8Array | null> => {
    while (queue.length === 0 && !streamDone && generation === streamGeneration) {
      await new Promise<void>((resolve) => {
        wakeConsumer = resolve;
      });
    }
    if (queue.length > 0) return queue.shift() ?? null;
    if (streamError) throw streamError;
    return null;
  };

  let firstAudioResolve: ((result: SpeakResult) => void) | null = null;
  let firstAudioReject: ((error: Error) => void) | null = null;
  let firstAudioSettled = false;
  let firstAudioTimeout: ReturnType<typeof setTimeout> | null = null;
  const firstAudio = new Promise<SpeakResult>((resolve, reject) => {
    firstAudioResolve = resolve;
    firstAudioReject = reject;
  });
  const settleFirst = () => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    if (firstAudioTimeout) clearTimeout(firstAudioTimeout);
    firstAudioResolve?.({
      source: 'gemini',
      chars: text.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      voice: currentVoice(),
      model: TTS_MODEL,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
    });
  };
  const rejectFirst = (error: Error) => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    if (firstAudioTimeout) clearTimeout(firstAudioTimeout);
    // A failed first player must invalidate the whole stream before the
    // caller starts expo-speech fallback. Otherwise a late PCM frame can
    // still arrive from the aborted request and play over the fallback.
    if (generation === streamGeneration) streamGeneration += 1;
    abortController.abort();
    wake();
    firstAudioReject?.(error);
  };

  void (async () => {
    try {
      const response = await expoFetch(TTS_ANDROID_STREAM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ text, voice: currentVoice() }),
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 429) noteQuotaExhausted();
        throw new Error(`TTS native stream unavailable (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let eventBuffer = '';
      const consumeEvents = (chunk: string) => {
        eventBuffer += chunk;
        const blocks = eventBuffer.split(/\r?\n\r?\n/);
        eventBuffer = blocks.pop() ?? '';
        for (const block of blocks) {
          let event = 'message';
          let data = '';
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as {
              audioBase64?: string;
              charsUsed?: number;
              charsLimit?: number;
              inputTokens?: number;
              outputTokens?: number;
              voice?: string;
              model?: string;
            };
            if (event === 'done') {
              publishUsage({
                charsUsed: parsed.charsUsed ?? lastUsage.charsUsed,
                charsLimit: parsed.charsLimit ?? lastUsage.charsLimit,
                inputTokens: parsed.inputTokens ?? lastUsage.inputTokens,
                outputTokens: parsed.outputTokens ?? lastUsage.outputTokens,
                voice: parsed.voice ?? currentVoice(),
                model: parsed.model ?? TTS_MODEL,
              });
              continue;
            }
            if (event !== 'audio' || !parsed.audioBase64) continue;
            const wav = base64ToBytes(parsed.audioBase64);
            const pcm = extractPcmFromWav(wav);
            if (pcm) push(pcm);
          } catch {
            // A malformed segment is ignored; the stream may still contain
            // later valid segments and the complete-WAV fallback remains armed.
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done || generation !== streamGeneration) break;
        if (!value?.length) continue;
        consumeEvents(decoder.decode(value, { stream: true }));
      }
      consumeEvents(decoder.decode());
    } catch (error) {
      if (!abortController.signal.aborted) {
        streamError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      streamDone = true;
      wake();
    }
  })();

  void (async () => {
    try {
      while (generation === streamGeneration) {
        const segment = await nextSegment();
        if (!segment) break;
        await playNativePcmSegment(segment, generation, settleFirst, text);
      }
      if (!firstAudioSettled) {
        rejectFirst(streamError ?? new Error('Native TTS stream contained no audio.'));
      } else {
        if (!streamError && generation === streamGeneration) {
          nativePcmCachePut(cacheKey(text.trim()), collectedSegments);
        }
        if (generation === streamGeneration && publishIdle) {
          publishPlayback({ active: false, durationMs: 0 });
        }
      }
      onComplete?.();
    } catch (error) {
      rejectFirst(error instanceof Error ? error : new Error(String(error)));
      if (generation === streamGeneration && publishIdle) {
        publishPlayback({ active: false, durationMs: 0 });
      }
      onComplete?.();
    }
  })();

  firstAudioTimeout = setTimeout(() => {
    rejectFirst(new Error('TTS first audio timeout.'));
  }, GEMINI_FIRST_TIMEOUT_MS);

  return firstAudio;
}

// Android-safe progressive transport. Gemini sends raw PCM frames, while this
// session receives the server's SSE mini-WAV frames and keeps only their PCM
// payload in a small FIFO. The player is opened only by the consumer, so a
// prefetch can begin before the Oracle is visible without opening a second
// audio player or making a second Gemini request.
interface NativeStreamSession {
  key: string;
  text: string;
  controller: AbortController;
  queue: Uint8Array[];
  collectedSegments: Uint8Array[];
  streamDone: boolean;
  streamError: Error | null;
  wakeConsumer: (() => void) | null;
  consumed: boolean;
  streamPromise: Promise<void>;
}

const nativeStreamSessions = new Map<string, NativeStreamSession>();

function startNativeStreamSession(text: string): NativeStreamSession {
  const trimmed = text.trim();
  const key = cacheKey(trimmed);
  const existing = nativeStreamSessions.get(key);
  if (existing && !existing.consumed) return existing;

  const session: NativeStreamSession = {
    key,
    text: trimmed,
    controller: new AbortController(),
    queue: [],
    collectedSegments: [],
    streamDone: false,
    streamError: null,
    wakeConsumer: null,
    consumed: false,
    streamPromise: Promise.resolve(),
  };
  nativeStreamSessions.set(key, session);
  let firstAudioSeen = false;
  let streamTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!firstAudioSeen && !session.streamDone) session.controller.abort();
  }, GEMINI_FIRST_TIMEOUT_MS);

  const wake = () => {
    session.wakeConsumer?.();
    session.wakeConsumer = null;
  };
  const push = (pcm: Uint8Array) => {
    const usableLength = pcm.length & ~1;
    if (usableLength <= 0) return;
    if (!firstAudioSeen) {
      firstAudioSeen = true;
      if (streamTimeout) {
        clearTimeout(streamTimeout);
        streamTimeout = null;
      }
    }
    const aligned = pcm.slice(0, usableLength);
    session.queue.push(aligned);
    session.collectedSegments.push(aligned.slice());
    wake();
  };

  session.streamPromise = (async () => {
    try {
      const response = await expoFetch(TTS_ANDROID_STREAM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ text: trimmed, voice: currentVoice() }),
        signal: session.controller.signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 429) noteQuotaExhausted();
        throw new Error(`TTS native stream unavailable (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let eventBuffer = '';
      const consumeEvents = (chunk: string) => {
        eventBuffer += chunk;
        const blocks = eventBuffer.split(/\r?\n\r?\n/);
        eventBuffer = blocks.pop() ?? '';
        for (const block of blocks) {
          let event = 'message';
          let data = '';
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as {
              audioBase64?: string;
              charsUsed?: number;
              charsLimit?: number;
              inputTokens?: number;
              outputTokens?: number;
              voice?: string;
              model?: string;
            };
            if (event === 'done') {
              publishUsage({
                charsUsed: parsed.charsUsed ?? lastUsage.charsUsed,
                charsLimit: parsed.charsLimit ?? lastUsage.charsLimit,
                inputTokens: parsed.inputTokens ?? lastUsage.inputTokens,
                outputTokens: parsed.outputTokens ?? lastUsage.outputTokens,
                voice: parsed.voice ?? currentVoice(),
                model: parsed.model ?? TTS_MODEL,
              });
              continue;
            }
            if (event !== 'audio' || !parsed.audioBase64) continue;
            const pcm = extractPcmFromWav(base64ToBytes(parsed.audioBase64));
            if (pcm) push(pcm);
          } catch {
            // Ignore one malformed SSE frame; later frames remain playable.
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) consumeEvents(decoder.decode(value, { stream: true }));
      }
      consumeEvents(decoder.decode());
      if (eventBuffer.trim()) consumeEvents('\n\n');
      if (session.queue.length === 0) {
        throw new Error('Native TTS stream contained no audio.');
      }
    } catch (error) {
      if (!session.controller.signal.aborted) {
        session.streamError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      if (streamTimeout) clearTimeout(streamTimeout);
      session.streamDone = true;
      wake();
      if (!session.streamError && session.collectedSegments.length > 0) {
        nativePcmCachePut(session.key, session.collectedSegments);
      }
    }
  })();

  return session;
}

async function playNativeStreamSession(
  session: NativeStreamSession,
): Promise<SpeakResult> {
  session.consumed = true;
  nativeStreamSessions.delete(session.key);
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
  const generation = ++streamGeneration;
  currentStreamAbortController = session.controller;
  const startedAt = Date.now();
  let firstAudioSettled = false;
  let firstAudioResolve: ((result: SpeakResult) => void) | null = null;
  let firstAudioReject: ((error: Error) => void) | null = null;
  const firstAudio = new Promise<SpeakResult>((resolve, reject) => {
    firstAudioResolve = resolve;
    firstAudioReject = reject;
  });
  const settleFirst = () => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    reportOracleFirstAudio(session.text, 'gemini', false);
    firstAudioResolve?.({
      source: 'gemini',
      chars: session.text.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      voice: currentVoice(),
      model: TTS_MODEL,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
    });
  };
  const rejectFirst = (error: Error) => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    firstAudioReject?.(error);
  };
  const nextSegment = async (): Promise<Uint8Array | null> => {
    while (
      session.queue.length === 0 &&
      !session.streamDone &&
      generation === streamGeneration
    ) {
      await new Promise<void>((resolve) => {
        session.wakeConsumer = resolve;
      });
    }
    if (session.queue.length > 0) return session.queue.shift() ?? null;
    if (session.streamError) throw session.streamError;
    return null;
  };

  let sharedPlayer: AudioPlayer | null = null;
  void (async () => {
    try {
      while (generation === streamGeneration) {
        const segment = await nextSegment();
        if (!segment) break;
        const nextPlayer = await playNativePcmSegment(
          segment,
          generation,
          settleFirst,
          session.text,
          undefined,
          sharedPlayer ?? undefined,
            true,
        );
        if (nextPlayer) sharedPlayer = nextPlayer;
      }
      if (!firstAudioSettled) {
        rejectFirst(session.streamError ?? new Error('Native TTS stream contained no audio.'));
      } else if (generation === streamGeneration) {
        publishPlayback({ active: false, durationMs: 0 });
      }
    } catch (error) {
      rejectFirst(error instanceof Error ? error : new Error(String(error)));
      if (generation === streamGeneration) publishPlayback({ active: false, durationMs: 0 });
    } finally {
      if (sharedPlayer) {
        if (currentPlayer === sharedPlayer) currentPlayer = null;
        try {
          sharedPlayer.remove();
        } catch {
          // The player may already have been released by stopTts().
        }
        sharedPlayer = null;
      }
      if (currentStreamAbortController === session.controller) {
        currentStreamAbortController = null;
      }
    }
  })();

  const firstAudioTimeout = setTimeout(() => {
    if (!firstAudioSettled) {
      session.controller.abort();
      rejectFirst(new Error('TTS first audio timeout.'));
    }
  }, GEMINI_FIRST_TIMEOUT_MS);
  try {
    return await firstAudio;
  } finally {
    clearTimeout(firstAudioTimeout);
  }
}

async function streamNativeTtsProgressive(text: string): Promise<SpeakResult> {
  return playNativeStreamSession(startNativeStreamSession(text));
}

function startSentencePrefetch(sentence: string): Promise<Uint8Array[]> {
  const cached = nativePcmCacheGet(cacheKey(sentence));
  if (cached?.length) {
    setPrep(cacheKey(sentence), 'ready');
    return Promise.resolve(cached);
  }
  const controller = new AbortController();
  const promise = prefetchNativeTts(sentence, controller);
  // A draw can be reset before the Oracle consumes this promise. Keep the
  // rejection handled in that case; the active reader will still receive it.
  void promise.catch(() => undefined);
  return promise;
}

async function playPreparedNativeSentences(
  text: string,
  warmup: NativeTtsWarmup,
  requestId: number,
): Promise<SpeakResult> {
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
  warmup.playbackStarted = true;
  const generation = ++streamGeneration;
  const startedAt = Date.now();
  let firstAudioResolve: ((result: SpeakResult) => void) | null = null;
  let firstAudioReject: ((error: Error) => void) | null = null;
  let firstAudioSettled = false;
  let firstAudioTimeout: ReturnType<typeof setTimeout> | null = null;
  const firstAudio = new Promise<SpeakResult>((resolve, reject) => {
    firstAudioResolve = resolve;
    firstAudioReject = reject;
  });
  const settleFirst = () => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    if (firstAudioTimeout) clearTimeout(firstAudioTimeout);
    firstAudioResolve?.({
      source: 'gemini',
      chars: text.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      voice: currentVoice(),
      model: TTS_MODEL,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
    });
  };
  const rejectFirst = (error: Error) => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    if (firstAudioTimeout) clearTimeout(firstAudioTimeout);
    firstAudioReject?.(error);
  };

  const playedSegments: Uint8Array[] = [];
  const playedSegmentTexts: string[] = [];
  void (async () => {
    try {
      for (let index = 0; index < warmup.sentences.length; index += 1) {
        if (
          warmup.cancelled ||
          requestId !== speakRequestId ||
          generation !== streamGeneration
        ) {
          throw new Error('Prepared TTS request superseded.');
        }
        const sentence = warmup.sentences[index];
        let audio: Uint8Array[] | undefined;
        try {
          // A later sentence may still be warming when playback catches up.
          // Always create/await that request instead of treating an empty slot
          // as the end of the reading.
          const pendingAudio =
            warmup.sentenceAudio[index] ??
            (warmup.sentenceAudio[index] = startSentencePrefetch(sentence));
          audio = await pendingAudio;
          if (!audio?.length) throw new Error('Prepared TTS sentence contained no audio.');
        } catch {
          // Retry one failed sentence independently. A transient Gemini
          // failure must not abort the remaining sentences in the reading.
          try {
            const retry = startSentencePrefetch(sentence);
            warmup.sentenceAudio[index] = retry;
            audio = await retry;
            if (!audio?.length) throw new Error('Retried TTS sentence contained no audio.');
          } catch {
            await speakWithNativeTts(sentence, true).catch(() => undefined);
            if (!firstAudioSettled) settleFirst();
            continue;
          }
        }
        nativePcmCachePut(cacheKey(sentence), audio);

        // Keep the next request ahead of playback. Only the first two are
        // opened during preparation, avoiding a burst of Gemini requests.
        const nextIndex = index + 1;
        if (nextIndex < warmup.sentences.length && !warmup.sentenceAudio[nextIndex]) {
          warmup.sentenceAudio[nextIndex] = startSentencePrefetch(
            warmup.sentences[nextIndex],
          );
        }
        // Gemini may split one sentence into several PCM frames. Joining the
        // frames before opening Android's player keeps the sentence on one
        // continuous clock and avoids tiny gaps or per-frame rate changes.
        const pcm = audio.reduce(
          (combined, segment) => concatBytes(combined, segment),
          new Uint8Array(0),
        );
        if (pcm.length > 0) {
          playedSegments.push(pcm);
          playedSegmentTexts.push(sentence);
          // Open a fresh player only after the previous sentence has fully
          // finished. Replacing an Android player between sentence WAVs can
          // produce a loud click/scratch at the boundary.
          await playNativePcmSegment(pcm, generation, settleFirst, sentence);
        }
      }
      if (!firstAudioSettled) {
        throw new Error('Prepared TTS contained no playable audio.');
      }
      if (generation === streamGeneration) {
        nativePcmCachePut(cacheKey(text), playedSegments);
        nativePcmChunkTexts.set(cacheKey(text), playedSegmentTexts.slice());
        nativeTtsWarmups.delete(warmup.key);
        publishPlayback({ active: false, durationMs: 0 });
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      rejectFirst(normalized);
      if (generation === streamGeneration) {
        publishPlayback({ active: false, durationMs: 0 });
      }
    } finally {
      // Each sentence owns and releases its own player after playback.
    }
  })();

  firstAudioTimeout = setTimeout(() => {
    rejectFirst(new Error('TTS first audio timeout.'));
  }, GEMINI_FIRST_TIMEOUT_MS);

  return firstAudio;
}

async function playCachedNativePcm(
  text: string,
  segments: Uint8Array[],
  chunkTexts?: string[],
): Promise<SpeakResult> {
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
  const generation = ++streamGeneration;
  const startedAt = Date.now();
  let firstAudioResolve: ((result: SpeakResult) => void) | null = null;
  let rejectCachedAudio: (error: Error) => void = () => undefined;
  let firstAudioSettled = false;
  const firstAudio = new Promise<SpeakResult>((resolve, reject) => {
    firstAudioResolve = resolve;
    rejectCachedAudio = reject;
  });
  const settleFirst = () => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    reportOracleFirstAudio(text, 'gemini', true);
    firstAudioResolve?.({
      source: 'gemini',
      chars: text.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      voice: currentVoice(),
      model: TTS_MODEL,
      latencyMs: Date.now() - startedAt,
      cacheHit: true,
    });
  };

  void (async () => {
    try {
      if (generation !== streamGeneration) {
        throw new Error('Cached TTS request superseded.');
      }
      const pcm = segments.reduce(
        (combined, segment) => concatBytes(combined, segment),
        new Uint8Array(0),
      );
      if (chunkTexts?.length === segments.length) {
        for (let index = 0; index < segments.length; index += 1) {
          await playNativePcmSegment(
            segments[index],
            generation,
            settleFirst,
            chunkTexts[index],
          );
        }
      } else if (pcm.length > 0) {
        const cachedFile = await ensureNativeWavFile(cacheKey(text), segments);
        await playNativePcmSegment(pcm, generation, settleFirst, text, cachedFile);
      }
      if (!firstAudioSettled) {
        throw new Error('Cached TTS contained no playable audio.');
      }
      if (generation === streamGeneration) {
        publishPlayback({ active: false, durationMs: 0 });
      }
    } catch (error) {
      if (!firstAudioSettled) {
        firstAudioSettled = true;
        rejectCachedAudio(error instanceof Error ? error : new Error(String(error)));
      }
      if (generation === streamGeneration) {
        publishPlayback({ active: false, durationMs: 0 });
      }
    } finally {
      // Each cached sentence owns and releases its own player after playback.
    }
  })();

  return firstAudio;
}

/**
 * Starts TTS for short text pieces without waiting for the complete reading.
 * Gemini's TTS endpoint often returns one large audio chunk per request, so
 * the latency win comes from sending the first sentence as its own request.
 */
export function enqueueTtsText(text: string): void {
  if (Platform.OS === 'web') return;
  const trimmed = text.trim();
  if (!trimmed) return;
  if (queuedNativeTextKeys.has(trimmed)) return;
  queuedNativeTextKeys.add(trimmed);
  const isFirstInRun = !nativeTextQueueRunning && queuedNativeJobs.length === 0;
  const job: NativeTextJob = {
    text: trimmed,
    controller: new AbortController(),
    prefetchedPcm: null,
    requestId: speakRequestId,
    queueRunId: nativeTextQueueRunId,
    isFirstInRun,
  };
  queuedNativeJobs.push(job);
  if (isFirstInRun) {
    // Start Gemini immediately, but keep the first player behind the
    // look-ahead barrier below so the first phrase cannot finish before the
    // second Gemini request is ready.
    job.prefetchedPcm = prefetchNativeTts(job.text, job.controller);
  }
  // The next request starts while the current sentence is still playing.
  // Its PCM is buffered in memory, but no second Android player is opened
  // until the current one has finished.
  if (
    queuedNativeJobs.length === 2 &&
    queuedNativeJobs[0]?.isFirstInRun &&
    !queuedNativeJobs[1]?.prefetchedPcm
  ) {
    queuedNativeJobs[1].prefetchedPcm = prefetchNativeTts(
      queuedNativeJobs[1].text,
      queuedNativeJobs[1].controller,
    );
  } else if (nativeTextQueueRunning && queuedNativeJobs.length === 1) {
    job.prefetchedPcm = prefetchNativeTts(job.text, job.controller);
  }
  if (!nativeTextQueueRunning && !nativeTextQueueStartScheduled) {
    nativeTextQueueStartScheduled = true;
    setTimeout(() => {
      nativeTextQueueStartScheduled = false;
      if (!nativeTextQueueRunning && queuedNativeJobs.length > 0) {
        void drainNativeTextQueue();
      }
    }, 0);
  }
}

async function drainNativeTextQueue(runId = nativeTextQueueRunId): Promise<void> {
  nativeTextQueueRunning = true;
  try {
    while (
      runId === nativeTextQueueRunId &&
      queuedNativeJobs.length > 0 &&
      Platform.OS !== 'web'
    ) {
      const job = queuedNativeJobs.shift();
      if (!job) continue;
      queuedNativeTextKeys.delete(job.text);
      if (
        job.requestId !== speakRequestId ||
        job.queueRunId !== nativeTextQueueRunId ||
        standaloneTtsActive
      ) {
        continue;
      }
      const nextJob = queuedNativeJobs[0];
      if (
        nextJob &&
        nextJob.queueRunId === nativeTextQueueRunId &&
        !nextJob.prefetchedPcm
      ) {
        nextJob.prefetchedPcm = prefetchNativeTts(nextJob.text, nextJob.controller);
      }
      try {
        if (job.prefetchedPcm) {
          const segments = await job.prefetchedPcm;
          nativePcmCachePut(cacheKey(job.text), segments);
          if (job.isFirstInRun) {
            const lookahead = queuedNativeJobs[0];
            // Both first requests are started together by enqueueTtsText().
            // Wait for the second Gemini result before opening the first
            // player; this removes the characteristic pause after sentence 1.
            if (lookahead?.prefetchedPcm) {
              await lookahead.prefetchedPcm.catch(() => null);
            }
          }
          if (
            job.requestId !== speakRequestId ||
            job.queueRunId !== nativeTextQueueRunId ||
            standaloneTtsActive
          ) {
            continue;
          }
          const pcm = segments.reduce(
            (combined, segment) => concatBytes(combined, segment),
            new Uint8Array(0),
          );
          if (pcm.length > 0) {
            if (
              job.requestId !== speakRequestId ||
              job.queueRunId !== nativeTextQueueRunId ||
              standaloneTtsActive
            ) {
              continue;
            }
            await playNativePcmSegment(pcm, streamGeneration, () => undefined, job.text);
          }
        } else {
          if (
            job.requestId !== speakRequestId ||
            job.queueRunId !== nativeTextQueueRunId ||
            standaloneTtsActive
          ) {
            continue;
          }
          let finishStream: (() => void) | null = null;
          const finished = new Promise<void>((resolve) => {
            finishStream = resolve;
          });
          await streamNativeTts(job.text, finishStream ?? undefined, false);
          await finished;
        }
      } catch {
        if (
          job.requestId !== speakRequestId ||
          job.queueRunId !== nativeTextQueueRunId ||
          standaloneTtsActive
        ) {
          continue;
        }
        // Keep the first phrase audible even if Android rejects a local WAV
        // segment. This fallback is sentence-sized, not the old full-reading
        // WAV request, so it cannot reintroduce the 20–25 second wait.
        await speakWithNativeTts(job.text, true).catch(() => undefined);
      }
    }
  } finally {
    if (runId === nativeTextQueueRunId) {
      queuedNativeJobs = [];
      queuedNativeTextKeys.clear();
      nativeTextQueueRunning = false;
    } else if (queuedNativeJobs.length > 0) {
      // The cancelled drain may still be unwinding its current player. Keep
      // the single-runner lock held and hand the new queue to the next drain
      // only after the old promise has fully settled.
      void drainNativeTextQueue(nativeTextQueueRunId);
    } else {
      nativeTextQueueRunning = false;
    }
  }
}

const STREAM_SAMPLE_RATE = 24_000;
const STREAM_WAV_HEADER_BYTES = 44;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result as Uint8Array<ArrayBuffer>;
}

function getWebAudioContext(): AudioContext | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AudioContextCtor ? new AudioContextCtor() : null;
}

/**
 * Consume the server's audio/x-wav stream as raw 16-bit PCM after its 44-byte
 * header. AudioBufferSourceNodes are scheduled back-to-back, so the first
 * Gemini chunk becomes audible without waiting for the complete WAV.
 *
 * Native playback uses the same PCM stream, but packages short PCM windows as
 * complete local WAV segments because Android media decoders cannot reliably
 * play an unknown-length WAV response.
 */
async function streamWebTts(text: string): Promise<SpeakResult> {
  const audioContext = getWebAudioContext();
  if (!audioContext) {
    return speakWithNativeTts(text).then(() => ({
      source: 'expo-speech',
      chars: text.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      fallback: true,
      latencyMs: 0,
    }));
  }

  const generation = ++streamGeneration;
  const abortController = new AbortController();
  currentStreamAbortController = abortController;
  const startedAt = Date.now();
  const estimatedDurationMs = Math.max(1800, text.length * 58);
  let nextAudioTime = 0;
  let headerBytes = new Uint8Array(0);
  let pcmRemainder = new Uint8Array(0);
  let firstAudioResolve: ((result: SpeakResult) => void) | null = null;
  let firstAudioReject: ((error: Error) => void) | null = null;
  let firstAudioSettled = false;

  const firstAudio = new Promise<SpeakResult>((resolve, reject) => {
    firstAudioResolve = resolve;
    firstAudioReject = reject;
  });

  const settleFirstAudio = (result: SpeakResult) => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    reportOracleFirstAudio(text, 'gemini', false);
    firstAudioResolve?.(result);
  };
  const rejectFirstAudio = (error: Error) => {
    if (firstAudioSettled) return;
    firstAudioSettled = true;
    firstAudioReject?.(error);
  };

  const schedulePcm = async (payload: Uint8Array) => {
    const bytes = concatBytes(pcmRemainder, payload);
    const usableLength = bytes.length - (bytes.length % 2);
    pcmRemainder = bytes.slice(usableLength);
    if (usableLength === 0 || generation !== streamGeneration) return;

    const sampleCount = usableLength / 2;
    const samples = new Float32Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usableLength);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => undefined);
    }
    const buffer = audioContext.createBuffer(1, sampleCount, STREAM_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    nextAudioTime = Math.max(nextAudioTime, audioContext.currentTime + 0.025);
    source.start(nextAudioTime);
    nextAudioTime += buffer.duration;
    currentStreamSources.add(source);
    source.onended = () => {
      currentStreamSources.delete(source);
      source.disconnect();
    };

    publishPlayback({ active: true, durationMs: estimatedDurationMs, text });
    settleFirstAudio({
      source: 'gemini',
      chars: text.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      voice: currentVoice(),
      model: TTS_MODEL,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
    });
  };

  void (async () => {
    try {
      const response = await fetch(TTS_STREAM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: currentVoice() }),
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        if (response.status === 429) noteQuotaExhausted();
        throw new Error(`TTS stream unavailable (${response.status})`);
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done || generation !== streamGeneration) break;
        if (!value?.length) continue;

        let pcm = value;
        if (headerBytes.length < STREAM_WAV_HEADER_BYTES) {
          headerBytes = concatBytes(headerBytes, value);
          if (headerBytes.length < STREAM_WAV_HEADER_BYTES) continue;
          pcm = headerBytes.slice(STREAM_WAV_HEADER_BYTES);
        }
        await schedulePcm(pcm);
      }

      if (!firstAudioSettled) {
        throw new Error('TTS stream contained no audio.');
      }
      if (generation === streamGeneration) {
        const remainingMs = Math.max(0, (nextAudioTime - audioContext.currentTime) * 1000);
        currentStreamEndTimer = setTimeout(() => {
          if (generation === streamGeneration) {
            publishPlayback({ active: false, durationMs: 0 });
            currentStreamAbortController = null;
          }
        }, remainingMs + 50);
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      rejectFirstAudio(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return firstAudio;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeLogId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function makePreview(text: string, max = 80): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

// ─── Public entry point ───────────────────────────────────────────────────────
export interface SpeakResult {
  source: 'gemini' | 'expo-speech';
  chars: number;
  charsUsed: number;
  charsLimit: number;
  inputTokens: number;
  outputTokens: number;
  voice?: string;
  model?: string;
  fallback?: boolean;
  latencyMs: number;
  cacheHit?: boolean;
  // True when no audio was actually played because Gemini TTS didn't return
  // a WAV within the patience window AND quota isn't exhausted. We never
  // expose this as expo-speech — the share-of-speech-text budget is
  // reserved for genuine outages.
  noAudio?: boolean;
}

/**
 * Starts independently playable, sentence-sized TTS chunks early. The first
 * sentence gets its own Gemini request so autoplay does not wait for synthesis
 * of the complete quick reading.
 */
export async function prefetchTts(text: string): Promise<void> {
  if (Platform.OS === 'web') return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const key = cacheKey(trimmed);
  if (audioCache.has(key) || getNativePcmForText(trimmed)?.length) {
    prefetchTimingByKey.set(key, {
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    setPrep(key, 'ready');
    return;
  }
  const prefetchStartedAt = Date.now();
  prefetchTimingByKey.set(key, { startedAt: prefetchStartedAt });
  const sentences = splitTtsChunks(trimmed);
  const warmup = startNativeTtsWarmup(
    trimmed,
    sentences.length > 0 ? sentences : [trimmed],
  );
  if (!warmup) {
    setPrep(key, 'error');
    return;
  }
  setPrep(key, 'pending');
  // Do not wait for the complete reading. The first sentence has its own
  // Gemini request and is the only asset autoplay needs to start. Remaining
  // sentences continue warming while the Oracle is revealed and while the
  // first phrase plays.
  await warmup.sentenceAudio[0]?.catch(() => undefined);
  prefetchTimingByKey.set(key, {
    startedAt: prefetchStartedAt,
    completedAt: Date.now(),
  });
  if (!warmup.sentenceAudio[0]) {
    setPrep(key, 'error');
  }
}

/**
 * Starts sentence-sized Android TTS requests while the cards are still
 * animating. Gemini often emits one large audio block per request, so sending
 * the whole 60–90 word reading would still delay the first sound until the
 * complete synthesis finishes. The first two sentences are requested now;
 * later sentences are kept one request ahead during playback.
 */
export async function prepareTts(text: string): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (getNativePcmForText(trimmed)?.length) return true;

  // Keep this public helper compatible for existing callers. The first sentence
  // is prepared immediately and later sentences stay one request ahead.
  await prefetchTts(trimmed);
  return Boolean(getNativePcmForText(trimmed)?.length);
}

export function releasePreparedTts(text: string): boolean {
  if (Platform.OS === 'web') return false;
  const warmup = findNativeTtsWarmup(text);
  if (!warmup) return false;
  warmup.cancelled = true;
  nativeTtsWarmups.delete(warmup.key);
  return true;
}

export async function speakText(text: string): Promise<SpeakResult> {
  const requestId = ++speakRequestId;
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty text');

  const totalStart = Date.now();
  const key = cacheKey(trimmed);
  const pendingWarmup =
    Platform.OS === 'web' ? undefined : findNativeTtsWarmup(trimmed);
  await stopTtsInternal(
    nativeStreamSessions.has(key) ? key : undefined,
    pendingWarmup?.key,
  );
  if (requestId !== speakRequestId) {
    throw new Error('TTS request superseded.');
  }
  standaloneTtsActive = true;

  const cachedNativePcm = Platform.OS === 'web' ? undefined : getNativePcmForText(trimmed);
  if (cachedNativePcm?.length) {
    setPrep(cacheKey(trimmed), 'ready');
    return await playCachedNativePcm(
      trimmed,
      cachedNativePcm,
      nativePcmChunkTexts.get(cacheKey(trimmed)),
    );
  }
  if (Platform.OS === 'web') {
    try {
      return await streamWebTts(trimmed);
    } catch {
      if (requestId !== speakRequestId) {
        throw new Error('TTS request superseded.');
      }
      await speakWithNativeTts(trimmed, false, true);
      reportOracleFirstAudio(trimmed, 'expo-speech', false);
      return {
        source: 'expo-speech',
        chars: trimmed.length,
        charsUsed: lastUsage.charsUsed,
        charsLimit: TTS_MONTHLY_LIMIT,
        inputTokens: lastUsage.inputTokens,
        outputTokens: lastUsage.outputTokens,
        fallback: true,
        latencyMs: Date.now() - totalStart,
      };
    }
  }

  // Android/iOS: consume the already-started mini-WAV SSE stream first. Each
  // segment is a valid local WAV and the FIFO guarantees one native player at a
  // time. A complete cached WAV is still handled above for replay.
  try {
    const warmup =
      pendingWarmup && !pendingWarmup.cancelled
        ? pendingWarmup
        : findNativeTtsWarmup(trimmed);
    if (warmup) {
      return await playPreparedNativeSentences(trimmed, warmup, requestId);
    }
    const pendingStream = nativeStreamSessions.get(key);
    if (pendingStream && !pendingStream.consumed) {
      return await playNativeStreamSession(pendingStream);
    }
    return await streamNativeTtsProgressive(trimmed);
  } catch {
    if (requestId !== speakRequestId) {
      throw new Error('TTS request superseded.');
    }
    const latency = Date.now() - totalStart;
    // A native user must always get audible feedback, but never after waiting
    // for a complete Gemini WAV. Use the phone's built-in French voice now.
    logAudio({
      id: makeLogId(),
      timestamp: Date.now(),
      textPreview: makePreview(trimmed),
      chars: trimmed.length,
      source: 'expo-speech',
      fallback: true,
      latencyMs: latency,
      cacheHit: false,
      reason: isQuotaExhausted() ? 'quota' : 'native-stream-unavailable',
    });
    setPrep(cacheKey(trimmed), 'error');
    await speakWithNativeTts(trimmed, false, true);
    reportOracleFirstAudio(trimmed, 'expo-speech', false);
    return {
      source: 'expo-speech',
      chars: trimmed.length,
      charsUsed: lastUsage.charsUsed,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens: lastUsage.inputTokens,
      outputTokens: lastUsage.outputTokens,
      fallback: true,
      latencyMs: latency,
    };
  }
}

// ─── Server-side audio stats (admin polling) ──────────────────────────────────
// ─── Server-side audio stats (admin polling) ──────────────────────────────────
export interface ServerAudioStats {
  lastReading?: {
    generationTimeMs: number;
    tts: Array<{
      id: string;
      timestamp: number;
      chars: number;
      firstAudioLatencyMs?: number;
      fallback: boolean;
    }>;
  } | null;
  quota: {
    monthKey: string;
    chars: number;
    limit: number;
    inputTokens: number;
    outputTokens: number;
    percent: number;
  };
  voice: string;
  model: string;
  language: string;
  totalCount: number;
  fallbackCount: number;
  fallbackRate: number;
  avgLatencyMs: number;
  avgFirstAudioLatencyMs: number;
  clientMetrics: {
    count: number;
    avgOracleToFirstAudioMs: number;
    avgPreparationMs: number;
    recent: Array<{
      id: string;
      timestamp: number;
      chars: number;
      textPreview: string;
      oracleToFirstAudioMs: number;
      preparationMs?: number;
      cacheHit: boolean;
      source: 'gemini' | 'expo-speech';
    }>;
  };
  rpm?: {
    total: number;
    primary: number;
    backup: number | null;
    vertex: number | null;
    windowSeconds: number;
  };
  recent: Array<{
    id: string;
    timestamp: number;
    chars: number;
    latencyMs: number;
    firstAudioLatencyMs?: number;
    fallback: boolean;
    textPreview: string;
    // Operator hint for *why* a fallback fired: "quota" (server 429),
    // "streaming" (one or both Gemini chunks failed), "error" (single-call
    // 5xx), or local "quota" / "timeout" from the client log.
    reason?: string;
  }>;
  // Daily running tally of TTS requests per Gemini project, both of them
  // tracked in parallel so the admin can see when to flip the active
  // project. Resets at midnight Pacific (Google's rate-limits calendar).
  daily?: {
    primary: { dateKey: string; used: number; limit: number };
    backup: { dateKey: string; used: number; limit: number } | null;
    vertex?: { dateKey: string; used: number; limit: number } | null;
    limit: number;
    thresholdPct: number;
  };
  // Which project is currently active server-side + an operator note
  // explaining auto-failover behavior. Helps the user understand WHY the
  // second pill is incrementing.
  projects?: {
    active: 'primary' | 'backup';
    note: string;
  };
}

export async function getServerAudioStats(): Promise<ServerAudioStats | null> {
  try {
    const response = await fetch(TTS_STATS_ENDPOINT, { method: 'GET' });
    if (!response.ok) return null;
    const data = (await response.json()) as ServerAudioStats;
    return data;
  } catch {
    return null;
  }
}
