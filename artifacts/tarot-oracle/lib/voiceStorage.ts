// Voice picker persistence.
//
// The selected studio voice lives in AsyncStorage so it survives app
// restarts. AsyncStorage is the canonical client cache for non-secret
// preferences; the server doesn't need to know which voice a user prefers.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_VOICE,
  isStudioVoice,
  type StudioVoice,
} from '@/lib/ttsVoices';

const SELECTED_VOICE_KEY = '@oracle/ttsVoice';
const VOICE_DEFAULT_MIGRATION_KEY = '@oracle/ttsVoiceDefaultKore';

// Default to Kore until the user picks something.
let cachedVoice: StudioVoice | null = null;
const voiceListeners = new Set<(v: StudioVoice) => void>();

function notifyVoice(v: StudioVoice) {
  cachedVoice = v;
  for (const l of voiceListeners) l(v);
}

export async function getSelectedVoice(): Promise<StudioVoice> {
  if (cachedVoice) return cachedVoice;
  try {
    const raw = await AsyncStorage.getItem(SELECTED_VOICE_KEY);
    if (isStudioVoice(raw)) {
      const migrated = await AsyncStorage.getItem(VOICE_DEFAULT_MIGRATION_KEY);
      if (!migrated && raw === 'Vindemiatrix') {
        await AsyncStorage.multiSet([
          [SELECTED_VOICE_KEY, DEFAULT_VOICE],
          [VOICE_DEFAULT_MIGRATION_KEY, '1'],
        ]);
        cachedVoice = DEFAULT_VOICE;
        return DEFAULT_VOICE;
      }
      if (!migrated) {
        await AsyncStorage.setItem(VOICE_DEFAULT_MIGRATION_KEY, '1');
      }
      cachedVoice = raw;
      return raw;
    }
    await AsyncStorage.setItem(VOICE_DEFAULT_MIGRATION_KEY, '1');
  } catch {
    // ignore — fall back to default
  }
  cachedVoice = DEFAULT_VOICE;
  return DEFAULT_VOICE;
}

export async function setSelectedVoice(voice: StudioVoice): Promise<void> {
  try {
    await AsyncStorage.setItem(SELECTED_VOICE_KEY, voice);
  } catch {
    // ignore — keep the in-memory value so the session still feels right
  }
  notifyVoice(voice);
}

export function subscribeSelectedVoice(
  listener: (v: StudioVoice) => void,
): () => void {
  voiceListeners.add(listener);
  return () => {
    voiceListeners.delete(listener);
  };
}

// Sync accessor used inside tts.ts — reads the in-memory cache populated by
// getSelectedVoice() at app boot. Falls back to the default voice while
// the first async read is still in flight.
export function getSelectedVoiceSync(): StudioVoice {
  return cachedVoice ?? DEFAULT_VOICE;
}

// Used by the wallet reset path (admin QA) to wipe voice preferences.
export async function resetVoicePreferences(): Promise<void> {
  cachedVoice = DEFAULT_VOICE;
  try {
    await Promise.all([
      AsyncStorage.removeItem(SELECTED_VOICE_KEY),
      AsyncStorage.removeItem(VOICE_DEFAULT_MIGRATION_KEY),
    ]);
  } catch {
    // ignore
  }
  notifyVoice(DEFAULT_VOICE);
}
