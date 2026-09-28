// Studio voice picker — the voices the user can choose from for TTS
// playback. Backed by Gemini 2.5 Flash preview TTS. Voices are tonal
// variants of the same warm French studio set:
//
//   - Kore:        female, calm and conversational — the default.
//   - Vindemiatrix: smooth, balanced, available as an alternate voice.
//   - Aoede:        bright and feminine, lighter pace — morning readings.
//   - Autonome:     neutral, clear, slightly formal — analytical draws.
//   - Leda:         warmer, deeper — comfort / reflection.
//   - Callirrhoe:   expressive, mid-tempo — follow-up detail readings.
//
// The list mirrors the TTS_VOICES allowlist on the server. Unknown values
// fall back to Kore server-side, so a mismatch here is harmless.

export type StudioVoice =
  | 'Kore'
  | 'Vindemiatrix'
  | 'Aoede'
  | 'Autonome'
  | 'Leda'
  | 'Callirrhoe';

export const DEFAULT_VOICE: StudioVoice = 'Kore';

export interface StudioVoiceInfo {
  id: StudioVoice;
  label: string;
  description: string;
  // Free-form hint used in suggestions ("essaie Aoede pour les tirages du matin").
  hint: string;
}

export const STUDIO_VOICES: StudioVoiceInfo[] = [
  {
    id: 'Kore',
    label: 'Kore',
    description: 'Voix féminine, calme, neutre et conversationnelle',
    hint: 'Lecture quotidienne, posée et rassurante · vitesse naturelle 1×',
  },
  {
    id: 'Vindemiatrix',
    label: 'Vindemiatrix',
    description: 'Voix douce et équilibrée',
    hint: 'Voix alternative pour les lectures',
  },
  {
    id: 'Aoede',
    label: 'Aoede',
    description: 'Voix claire et lumineuse, légèrement féminine',
    hint: 'Privilégie Aoede pour les tirages du matin',
  },
  {
    id: 'Autonome',
    label: 'Autonome',
    description: 'Voix neutre et analytique, légèrement formelle',
    hint: 'Privilégie Autonome pour les tirages analytiques',
  },
  {
    id: 'Leda',
    label: 'Leda',
    description: 'Voix plus grave et chaleureuse, ton réconfortant',
    hint: 'Privilégie Leda pour les tirages de réconfort',
  },
  {
    id: 'Callirrhoe',
    label: 'Callirrhoe',
    description: 'Voix expressive, débit médium, ton vivant',
    hint: 'Privilégie Callirrhoe pour les lectures de suivi',
  },
];

export function isStudioVoice(value: unknown): value is StudioVoice {
  return (
    typeof value === 'string' &&
    STUDIO_VOICES.some((v) => v.id === value)
  );
}

export function getStudioVoiceInfo(id: string): StudioVoiceInfo {
  return STUDIO_VOICES.find((v) => v.id === id) ?? STUDIO_VOICES[0];
}
