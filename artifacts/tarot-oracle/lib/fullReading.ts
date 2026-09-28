// Single-call reading helper.
//
// Hits the server's POST /api/tarot/reading/full endpoint which returns
// shortReading + longReading + advice + nextSteps + suggestedQuestions in
// ONE LLM round-trip (cache-hits after the first call for the same
// question + cards hash). This replaces the legacy 2-call flow
// (/reading then /reading/detail) — the drawing screen still spends 20
// credits up-front for the short view and 40 on unlock for the detail,
// but the server hits Gemini once per unique question+cards pair.
import { fetch as expoFetch } from 'expo/fetch';

export interface FullReadingCard {
  name: string;
  theme: string;
  upright: string;
  reversed: string;
  position: string;
  isReversed: boolean;
}

export interface FullReadingRequest {
  question: string;
  cards: FullReadingCard[];
}

export interface FullReadingResponse {
  shortReading: string;
  longReading: string;
  advice: string;
  nextSteps: string;
  suggestedQuestions: string[];
  creditsUsed: number;
  cacheHit: boolean;
  generationTimeMs: number;
}

const apiBaseUrl = process.env.EXPO_PUBLIC_DOMAIN ?? '';
const FULL_READING_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/full`;
const FULL_READING_STREAM_ENDPOINT = `https://${apiBaseUrl}/api/tarot/reading/full/stream`;

export interface FullReadingStreamHandlers {
  onShortReading?: (value: string, complete: boolean) => void;
}

export async function createFullReading(
  data: FullReadingRequest,
): Promise<FullReadingResponse> {
  const response = await fetch(FULL_READING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const detail = await safeReadJson(response);
    throw new Error(
      `Lecture indisponible (${response.status}) — ${
        detail?.error ?? response.statusText
      }`,
    );
  }
  const json = (await response.json()) as Partial<FullReadingResponse>;
  return {
    shortReading: json.shortReading ?? '',
    longReading: json.longReading ?? '',
    advice: json.advice ?? '',
    nextSteps: json.nextSteps ?? '',
    suggestedQuestions: Array.isArray(json.suggestedQuestions)
      ? json.suggestedQuestions.slice(0, 3)
      : [],
    creditsUsed: typeof json.creditsUsed === 'number' ? json.creditsUsed : 25,
    cacheHit: json.cacheHit === true,
    generationTimeMs:
      typeof json.generationTimeMs === 'number' ? json.generationTimeMs : 0,
  };
}

export async function streamFullReading(
  data: FullReadingRequest,
  handlers: FullReadingStreamHandlers = {},
): Promise<FullReadingResponse> {
  const response = await expoFetch(FULL_READING_STREAM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(data),
  });
  if (!response.ok || !response.body) {
    const detail = await safeReadJson(response);
    throw new Error(
      `Lecture indisponible (${response.status}) — ${
        detail?.error ?? response.statusText
      }`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: FullReadingResponse | null = null;
  let streamError: string | null = null;

  const consume = (text: string) => {
    buffer += text;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      let event = 'message';
      let payload = '';
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) payload += line.slice(5).trim();
      }
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as {
          value?: string;
          complete?: boolean;
          error?: string;
          shortReading?: string;
          longReading?: string;
          advice?: string;
          nextSteps?: string;
          suggestedQuestions?: unknown;
          creditsUsed?: number;
          cacheHit?: boolean;
          generationTimeMs?: number;
        };
        if (event === 'shortReading' && typeof parsed.value === 'string') {
          handlers.onShortReading?.(parsed.value, parsed.complete === true);
        } else if (event === 'done') {
          finalResponse = {
            shortReading: parsed.shortReading ?? '',
            longReading: parsed.longReading ?? '',
            advice: parsed.advice ?? '',
            nextSteps: parsed.nextSteps ?? '',
            suggestedQuestions: Array.isArray(parsed.suggestedQuestions)
              ? parsed.suggestedQuestions.filter((value): value is string => typeof value === 'string').slice(0, 3)
              : [],
            creditsUsed: typeof parsed.creditsUsed === 'number' ? parsed.creditsUsed : 25,
            cacheHit: parsed.cacheHit === true,
            generationTimeMs:
              typeof parsed.generationTimeMs === 'number' ? parsed.generationTimeMs : 0,
          };
        } else if (event === 'error') {
          streamError = parsed.error ?? 'Lecture indisponible.';
        }
      } catch {
        // Ignore an incomplete/malformed SSE frame and continue consuming.
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) consume(decoder.decode(value, { stream: true }));
  }
  consume(decoder.decode());

  if (streamError) throw new Error(streamError);
  if (!finalResponse) throw new Error('La lecture streamée est incomplète.');
  return finalResponse;
}

async function safeReadJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
