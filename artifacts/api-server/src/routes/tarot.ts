import { Router } from "express";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import {
  getCachedReading,
  setCachedReading,
} from "../lib/readingCache";

const router = Router();

let lastReadingTiming: {
  startedAt: number;
  generationTimeMs: number;
  completedAt: number;
} | null = null;

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
// ╭─ Failover Gemini client ────────────────────────────────────────────────╮
// │ When the primary project hits the daily `GenerateRequestsPerDayPerModel`
// │ 100 cap on `gemini-2.5-flash-preview-tts`, TTS calls can run through
// │ this backup. Text readings (tarot content) keep going through the
// │ primary so the voice tone of the LLM stays identical.
// ╰─────────────────────────────────────────────────────────────────────────╯
const geminiBackup: GoogleGenAI | null = process.env.GEMINI_API_KEY_BACKUP?.trim()
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY_BACKUP })
  : null;
// Optional third TTS project. It is intentionally used only by the TTS
// failover chain; tarot text generation remains on the primary client.
const geminiVertex: GoogleGenAI | null = process.env.VERTEX_AI_API_KEY?.trim()
  ? new GoogleGenAI({
      apiKey: process.env.VERTEX_AI_API_KEY,
      vertexai: true,
      apiVersion: "v1",
    })
  : null;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface TarotCardInput {
  name: string;
  theme: string;
  upright: string;
  reversed: string;
  position: string;
  isReversed: boolean;
}

interface TarotReadingContext {
  shortReading: string;
  longReading: string;
  advice: string;
  nextSteps: string;
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();

  const truncated = words.slice(0, maxWords).join(" ");
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("?"),
    truncated.lastIndexOf("!"),
  );
  if (lastSentenceEnd > 0) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }
  return truncated + "…";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isArrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0);
}

function buildCardsText(cards: TarotCardInput[]): string {
  return cards
    .map(
      (card, i) =>
        `${i + 1}. Carte : ${card.name} | Position : ${card.position} | Sens : ${card.isReversed ? "Renversé" : "Droit"}
   Signification : ${card.isReversed ? card.reversed : card.upright}
   Thème : ${card.theme}`,
    )
    .join("\n");
}

function buildPrompts(
  question: string,
  cards: TarotCardInput[],
): { systemPrompt: string; userPrompt: string } {
  const cardsText = buildCardsText(cards);

  const systemPrompt = `Tu es un oracle du tarot moderne, clair et pédagogique. Tu réponds dans un ton simple, direct et facile à comprendre, sans jargon ésotérique inutile.
Tu dois répondre UNIQUEMENT en JSON valide avec exactement ces quatre champs : "shortReading", "longReading", "advice", "nextSteps".

Règles strictes :
- "shortReading" : entre 60 et 90 mots, jamais plus de 90 mots. Réponse directe, précise et complète à la question, compréhensible immédiatement. Mentionne les cartes et leurs positions si cela aide la clarté.
- "longReading" : environ 200 mots, jamais plus de 220 mots. Explique précisément pourquoi chaque carte, dans sa position et son sens (droit ou renversé), conduit à cette réponse. Privilégie l'analyse factuelle et les liens causaux entre le passé, le présent et l'avenir. Évite les images poétiques vides.
- "advice" : 3 à 4 phrases, un conseil pratique et approfondi issu du tirage.
- "nextSteps" : 3 à 4 phrases, l'action concrète et les premières étapes à faire maintenant.

N'utilise pas de titres, de listes à puces ni de markdown. Écris en français, en prose fluide et naturelle.`;

  const userPrompt = `Question de l'utilisateur : "${question}"

Cartes tirées :
${cardsText}

Interprète ce tirage de manière claire et pédagogique.`;

  return { systemPrompt, userPrompt };
}

function buildShortPrompts(
  question: string,
  cards: TarotCardInput[],
): { systemPrompt: string; userPrompt: string } {
  const cardsText = buildCardsText(cards);

  const systemPrompt = `Tu es un oracle du tarot moderne, clair et pédagogique. Tu réponds dans un ton simple, direct et facile à comprendre, sans jargon ésotérique inutile.
Tu dois répondre UNIQUEMENT en JSON valide avec exactement ce champ : "shortReading".

Règle stricte :
- "shortReading" : entre 60 et 90 mots, jamais plus de 90 mots. Réponds directement, précisément et complètement à la question, en mentionnant les cartes tirées et leurs positions si pertinent. Termine par une phrase courte et accrocheuse qui donne envie de découvrir la lecture détaillée, sans révéler ce qu'elle contient.

N'utilise pas de titres, de listes à puces ni de markdown. Écris en français, en prose fluide et naturelle.`;

  const userPrompt = `Question de l'utilisateur : "${question}"

Cartes tirées :
${cardsText}

Donne une réponse courte, précise et claire à cette question, en t'appuyant sur le tirage.`;

  return { systemPrompt, userPrompt };
}

function buildDetailPrompts(
  question: string,
  cards: TarotCardInput[],
): { systemPrompt: string; userPrompt: string } {
  const cardsText = buildCardsText(cards);

  const systemPrompt = `Tu es un oracle du tarot moderne, clair et pédagogique. Tu réponds dans un ton simple, direct et facile à comprendre, sans jargon ésotérique inutile.
Tu dois répondre UNIQUEMENT en JSON valide avec exactement ces trois champs : "longReading", "advice", "nextSteps".

Règles strictes :
- "longReading" : environ 120 mots, jamais plus de 140 mots. Explique précisément pourquoi chaque carte, dans sa position et son sens (droit ou renversé), conduit à cette réponse. Privilégie l'analyse factuelle et concise ; évite les images poétiques vides.
- "advice" : 2 à 3 phrases, un conseil pratique et direct issu du tirage.
- "nextSteps" : 2 à 3 phrases, l'action concrète et les premières étapes à faire maintenant.

N'utilise pas de titres, de listes à puces ni de markdown. Écris en français, en prose fluide et naturelle.`;

  const userPrompt = `Question de l'utilisateur : "${question}"

Cartes tirées :
${cardsText}

Développe une lecture détaillée, un conseil et des étapes concrètes pour cette question.`;

  return { systemPrompt, userPrompt };
}

function buildFollowUpQuestionsPrompts(
  question: string,
  cards: TarotCardInput[],
  context: TarotReadingContext,
): { systemPrompt: string; userPrompt: string } {
  const cardsText = buildCardsText(cards);

  const systemPrompt = `Tu es un oracle du tarot moderne, clair et pédagogique. Tu réponds UNIQUEMENT en JSON valide avec exactement ce champ : "questions" (un tableau de 3 chaînes très courtes).

Règles strictes :
- "questions" : exactement 3 questions de suivi très courtes, pertinentes et variées. Chaque question doit :
  - prolonger NATURELLEMENT la lecture précédente en s'appuyant sur les mêmes cartes tirées,
  - être directement reliée à la question originale de l'utilisateur (même sujet concret),
  - être concrète et ancrée dans la vie réelle (travail, argent, relation, décision, timing) — JAMAIS de question abstraite, mystique ou ornementale,
  - mentionner si possible un détail précis du tirage (un symbole, une carte, un mot-clé de la lecture) pour montrer qu'elle découle vraiment de la lecture,
  - aider l'utilisateur à obtenir une réponse actionnable, pas juste une belle phrase.
- Longueur maximale : 60 caractères par question, espaces compris. Chaque question doit tenir entièrement sur un bouton d'application mobile. Privilégie 35-50 caractères.
- Phrase interrogative naturelle, comme si un ami qui connaissait bien la situation te demandait d'en savoir plus.
- Ne pas inclure de ponctuation finale inutile.

Exemples de TON à éviter : "Que cache cette énergie subtile ?", "Quel mystère m'est révélé ?".
Exemples de TON à privilégier : "Comment gérer ce blocage au travail cette semaine ?", "Quel aspect concret de la relation dois-je améliorer maintenant ?".

N'utilise pas de titres, de listes à puces ni de markdown. Écris en français.`;

  const userPrompt = `Question originale : "${question}"

Cartes tirées :
${cardsText}

Lecture rapide précédente : "${context.shortReading}"
Lecture détaillée précédente : "${context.longReading}"
Conseil précédent : "${context.advice}"
Prochaines étapes précédentes : "${context.nextSteps}"

Propose 3 questions de suivi courtes et pertinentes pour approfondir cette lecture.`;

  return { systemPrompt, userPrompt };
}

function buildFollowUpDetailPrompts(
  question: string,
  cards: TarotCardInput[],
  context: TarotReadingContext,
  followUpQuestion: string,
): { systemPrompt: string; userPrompt: string } {
  const cardsText = buildCardsText(cards);

  const systemPrompt = `Tu es un oracle du tarot moderne, clair et pédagogique. Tu réponds UNIQUEMENT en JSON valide avec exactement ces trois champs : "longReading", "advice", "nextSteps".

Règles strictes :
- "longReading" : environ 100 mots, jamais plus de 120 mots. Réponds précisément à la question de suivi en réutilisant les mêmes cartes. Explique brièvement comment chaque carte éclaire cette question de suivi. Privilégie l'analyse factuelle et concise ; évite les images poétiques vides.
- "advice" : 2 à 3 phrases, un conseil pratique et direct issu du tirage.
- "nextSteps" : 2 à 3 phrases, l'action concrète et les premières étapes à faire maintenant.

N'utilise pas de titres, de listes à puces ni de markdown. Écris en français, en prose fluide et naturelle.`;

  const userPrompt = `Question originale : "${question}"
Question de suivi : "${followUpQuestion}"

Cartes tirées :
${cardsText}

Lecture rapide précédente : "${context.shortReading}"
Lecture détaillée précédente : "${context.longReading}"
Conseil précédent : "${context.advice}"
Prochaines étapes précédentes : "${context.nextSteps}"

Développe une nouvelle lecture détaillée qui répond spécifiquement à la question de suivi, en utilisant les mêmes cartes.`;

  return { systemPrompt, userPrompt };
}

// Single-call prompt: returns shortReading + longReading + advice + nextSteps
// + 3 suggested follow-up questions in ONE LLM round-trip. Drives the
// "1 RPD/lecture" wave — the mobile client posts a single request and gets
// back everything the reading needs without a second call. The server
// caches the response keyed by (question, cards) so a replay for the same
// draw with the same question is instant.
function buildFullReadingPrompts(
  question: string,
  cards: TarotCardInput[],
): { systemPrompt: string; userPrompt: string } {
  const cardsText = buildCardsText(cards);

  const systemPrompt = `Tu es un oracle du tarot moderne, clair et pédagogique. Tu réponds dans un ton simple, direct et facile à comprendre, sans jargon ésotérique inutile.
Tu dois répondre UNIQUEMENT en JSON valide avec exactement ces cinq champs : "shortReading", "longReading", "advice", "nextSteps", "questions".

Règles strictes :
- "shortReading" : entre 60 et 90 mots, jamais plus de 90 mots. Réponse directe, précise et complète à la question, compréhensible immédiatement. Mentionne les cartes et leurs positions si cela aide la clarté. Termine par une phrase courte et accrocheuse qui donne envie de découvrir la lecture détaillée, sans révéler ce qu'elle contient.
- "longReading" : environ 200 mots, jamais plus de 220 mots. Explique précisément pourquoi chaque carte, dans sa position et son sens (droit ou renversé), conduit à cette réponse. Privilégie l'analyse factuelle et les liens causaux entre le passé, le présent et l'avenir. Évite les images poétiques vides.
- "advice" : 3 à 4 phrases, un conseil pratique et approfondi issu du tirage.
- "nextSteps" : 3 à 4 phrases, l'action concrète et les premières étapes à faire maintenant.
- "questions" : tableau de exactement 3 chaînes très courtes (max 60 caractères par question), pertinentes et variées. Chaque question doit prolonger naturellement la lecture précédente, mentionner si possible un détail précis du tirage (carte, symbole, mot-clé), être concrète et ancrée dans la vie réelle (travail, argent, relation, décision, timing). Jamais de question abstraite, mystique ou ornementale. Style : comme si un ami qui connaîtrait bien ta situation te demandait d'en savoir plus.

N'utilise pas de titres, de listes à puces ni de markdown. Écris en français, en prose fluide et naturelle.`;

  const userPrompt = `Question de l'utilisateur : "${question}"

Cartes tirées :
${cardsText}

Interprète ce tirage de manière claire et pédagogique, avec une lecture rapide accrocheuse, une lecture détaillée qui justifie chaque carte, un conseil concret, des étapes concrètes, et 3 questions de suivi pertinentes pour approfondir.`;

  return { systemPrompt, userPrompt };
}

async function generateWithGemini(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const result = await gemini.models.generateContent({
    model: "gemini-2.5-flash",
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      temperature: 0.8,
      maxOutputTokens: 8192,
    },
  });
  return result.text ?? "";
}

async function generateWithOpenAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.8,
    max_tokens: 8192,
  });
  return result.choices[0]?.message?.content ?? "";
}

async function generateReading(
  systemPrompt: string,
  userPrompt: string,
  log?: any,
): Promise<{ content: string; provider: string }> {
  try {
    const content = await generateWithGemini(systemPrompt, userPrompt);
    return { content, provider: "gemini" };
  } catch (err) {
    if (!process.env.OPENAI_API_KEY || !shouldFallbackToOpenAI(err)) {
      throw err;
    }

    log?.warn?.({ err }, "Gemini unavailable; falling back to OpenAI");
    const content = await generateWithOpenAI(systemPrompt, userPrompt);
    return { content, provider: "openai" };
  }
}

async function generateReadingWithRetry<T>(
  systemPrompt: string,
  userPrompt: string,
  parse: (content: string) => T,
  log?: any,
  maxAttempts: number = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { content, provider } = await generateReading(systemPrompt, userPrompt, log);
      return parse(content);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts;
      log?.warn?.({ attempt, err, isLast }, "AI generation or parse failed");
      if (isLast) break;
      await new Promise((resolve) => setTimeout(resolve, 800 + attempt * 400));
    }
  }
  throw lastErr;
}

function parseReadingResponse(content: string) {
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonCandidate = jsonBlockMatch ? jsonBlockMatch[1] : content;
  return JSON.parse(jsonCandidate) as {
    shortReading?: string;
    longReading?: string;
    advice?: string;
    nextSteps?: string;
  };
}

function parseFollowUpQuestionsResponse(content: string) {
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonCandidate = jsonBlockMatch ? jsonBlockMatch[1] : content;
  const parsed = JSON.parse(jsonCandidate) as { questions?: unknown };
  if (!isArrayOfStrings(parsed.questions)) {
    throw new Error("Invalid follow-up questions response: questions must be an array of 3 strings");
  }
  return { questions: parsed.questions.slice(0, 3) };
}

function parseFullReadingResponse(content: string) {
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonCandidate = jsonBlockMatch ? jsonBlockMatch[1] : content;
  const parsed = JSON.parse(jsonCandidate) as {
    shortReading?: string;
    longReading?: string;
    advice?: string;
    nextSteps?: string;
    questions?: unknown;
  };
  if (!isArrayOfStrings(parsed.questions)) {
    throw new Error(
      "Invalid full reading response: questions must be an array of 3 strings",
    );
  }
  return {
    shortReading: parsed.shortReading,
    longReading: parsed.longReading,
    advice: parsed.advice,
    nextSteps: parsed.nextSteps,
    questions: parsed.questions.slice(0, 3),
  };
}

function extractJsonStringProgress(
  source: string,
  field: string,
): { value: string; complete: boolean } | null {
  const marker = `"${field}"`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const colonIndex = source.indexOf(":", markerIndex + marker.length);
  if (colonIndex < 0) return null;
  const quoteIndex = source.indexOf('"', colonIndex + 1);
  if (quoteIndex < 0) return null;

  let escaped = false;
  let raw = "";
  for (let i = quoteIndex + 1; i < source.length; i += 1) {
    const character = source[i];
    if (!escaped && character === '"') {
      return { value: decodeJsonStringFragment(raw), complete: true };
    }
    if (!escaped && character === "\\") {
      escaped = true;
      raw += character;
      continue;
    }
    raw += character;
    escaped = false;
  }
  return { value: decodeJsonStringFragment(raw), complete: false };
}

function decodeJsonStringFragment(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }
}

function writeSse(res: any, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function isQuotaError(err: unknown): boolean {
  const errorMessage = (err as Error)?.message ?? "";
  return (
    errorMessage.includes("429") ||
    errorMessage.includes("quota") ||
    errorMessage.includes("ResourceExhausted") ||
    errorMessage.includes("Rate limit") ||
    errorMessage.includes("rate limit")
  );
}

function isModelUnavailableError(err: unknown): boolean {
  const errorMessage = (err as Error)?.message ?? "";
  return (
    errorMessage.includes("404") ||
    errorMessage.includes("no longer available") ||
    errorMessage.includes("is not found") ||
    errorMessage.includes("not supported") ||
    errorMessage.includes("Model not found")
  );
}

function shouldFallbackToOpenAI(err: unknown): boolean {
  return isQuotaError(err) || isModelUnavailableError(err);
}

function handleGenerationError(err: unknown, res: any, log?: any) {
  const errorMessage = (err as Error)?.message ?? "";
  const quota = isQuotaError(err);
  log?.error?.({ err }, "AI tarot generation failed");
  res.status(quota ? 429 : 500).json({
    error: quota
      ? "Quota IA épuisé. Vérifiez votre plan et facturation, puis réessayez."
      : "Impossible de générer la lecture pour le moment.",
  });
}

function validateRequest(
  req: any,
  res: any,
): { question: string; cards: TarotCardInput[] } | null {
  const { question, cards } = req.body as {
    question: string;
    cards: TarotCardInput[];
  };

  if (!question || !cards || cards.length !== 3) {
    res.status(400).json({ error: "Paramètres manquants ou invalides." });
    return null;
  }

  return { question, cards };
}

function validateContext(body: any): TarotReadingContext | null {
  const ctx = body?.context as Partial<TarotReadingContext> | undefined;
  if (
    !ctx ||
    !isNonEmptyString(ctx.shortReading) ||
    !isNonEmptyString(ctx.longReading) ||
    !isNonEmptyString(ctx.advice) ||
    !isNonEmptyString(ctx.nextSteps)
  ) {
    return null;
  }
  return ctx as TarotReadingContext;
}

router.post("/tarot/reading", async (req, res) => {
  const payload = validateRequest(req, res);
  if (!payload) return;

  const { question, cards } = payload;
  const { systemPrompt, userPrompt } = buildShortPrompts(question, cards);

  const startTime = Date.now();
  try {
    const parsed = await generateReadingWithRetry(
      systemPrompt,
      userPrompt,
      (content) => parseReadingResponse(content),
      req.log,
      3,
    );

    const rawShort = isNonEmptyString(parsed.shortReading)
      ? parsed.shortReading
      : "Le tirage révèle des énergies en transformation.";

    res.json({
      shortReading: truncateToWords(rawShort, 90),
      creditsUsed: 25,
      generationTimeMs: Date.now() - startTime,
    });
  } catch (err) {
    handleGenerationError(err, res, req.log);
  }
});

// Single-call reading endpoint — drives the "1 RPD/lecture" wave. Returns
// shortReading + longReading + advice + nextSteps + 3 suggested follow-up
// questions in ONE LLM round-trip, then caches the response keyed by
// (question, cards) so the next replay for the same draw + question is
// served from the LRU cache without paying the Gemini cost again.
// The initial request is billed as the quick reading. The staged detailed
// reading is billed separately when the user unlocks it.
router.post("/tarot/reading/full", async (req, res) => {
  const payload = validateRequest(req, res);
  if (!payload) return;

  const { question, cards } = payload;
  const cacheParts = {
    question,
    cards: cards.map((c) => ({
      name: c.name,
      position: c.position,
      isReversed: c.isReversed === true,
    })),
    endpoint: "tarot/reading/full",
  };

  const cached = getCachedReading<{
    shortReading?: string;
    longReading?: string;
    advice?: string;
    nextSteps?: string;
    questions: string[];
  }>(cacheParts);
  if (cached) {
    const stamp = Date.now();
    req.log?.info(
      { cacheKey: cached.key.slice(0, 8) },
      "Serving reading from cache (no LLM call)",
    );
    res.json({
      shortReading: truncateToWords(
        isNonEmptyString(cached.payload.shortReading)
          ? (cached.payload.shortReading as string)
          : "Le tirage révèle des énergies en transformation.",
        90,
      ),
      longReading: truncateToWords(
        isNonEmptyString(cached.payload.longReading)
          ? (cached.payload.longReading as string)
          : "Une lecture approfondie est en préparation, les cartes parlent...",
        220,
      ),
      advice: truncateToWords(
        isNonEmptyString(cached.payload.advice)
          ? (cached.payload.advice as string)
          : "Faites confiance à votre intuition.",
        45,
      ),
      nextSteps: truncateToWords(
        isNonEmptyString(cached.payload.nextSteps)
          ? (cached.payload.nextSteps as string)
          : "Observez les signes qui se présentent.",
        45,
      ),
      suggestedQuestions: cached.payload.questions.slice(0, 3),
      creditsUsed: 25,
      cacheHit: true,
      generationTimeMs: 0,
    });
    return;
  }

  const { systemPrompt, userPrompt } = buildFullReadingPrompts(question, cards);

  const startTime = Date.now();
  try {
    const parsed = await generateReadingWithRetry(
      systemPrompt,
      userPrompt,
      (content) => parseFullReadingResponse(content),
      req.log,
      4,
    );

    const rawShort = isNonEmptyString(parsed.shortReading)
      ? parsed.shortReading
      : "Le tirage révèle des énergies en transformation.";
    const rawLong = isNonEmptyString(parsed.longReading)
      ? parsed.longReading
      : "Une lecture approfondie est en préparation, les cartes parlent...";
    const rawAdvice = isNonEmptyString(parsed.advice)
      ? parsed.advice
      : "Faites confiance à votre intuition.";
    const rawNextSteps = isNonEmptyString(parsed.nextSteps)
      ? parsed.nextSteps
      : "Observez les signes qui se présentent.";
    const suggestedQuestions = parsed.questions;

    const missingCardNames = cards
      .map((c) => c.name)
      .filter((name) => !rawLong.toLowerCase().includes(name.toLowerCase()));
    if (missingCardNames.length > 0) {
      req.log.warn(
        { missingCardNames, longReading: rawLong },
        "Full long reading missing card names; accepting truncated response but logging",
      );
    }

    setCachedReading(cacheParts, {
      shortReading: rawShort,
      longReading: rawLong,
      advice: rawAdvice,
      nextSteps: rawNextSteps,
      questions: suggestedQuestions,
    });

    req.log?.info(
      {
        chars: rawShort.length + rawLong.length + rawAdvice.length + rawNextSteps.length,
        latencyMs: Date.now() - startTime,
      },
      "Generated full reading (1 LLM call, cached for replay)",
    );

    res.json({
      shortReading: truncateToWords(rawShort, 90),
      longReading: truncateToWords(rawLong, 220),
      advice: truncateToWords(rawAdvice, 45),
      nextSteps: truncateToWords(rawNextSteps, 45),
      suggestedQuestions,
      creditsUsed: 25,
      cacheHit: false,
      generationTimeMs: Date.now() - startTime,
    });
  } catch (err) {
    handleGenerationError(err, res, req.log);
  }
});

// SSE variant used by the Android client. The model still returns one strict
// JSON document, but the client receives the shortReading field as soon as it
// appears in the ordered response, then receives the validated complete
// payload in the final event.
router.post("/tarot/reading/full/stream", async (req, res) => {
  const payload = validateRequest(req, res);
  if (!payload) return;

  const { question, cards } = payload;
  const readingStartedAt = Date.now();
  const cacheParts = {
    question,
    cards: cards.map((c) => ({
      name: c.name,
      position: c.position,
      isReversed: c.isReversed === true,
    })),
    endpoint: "tarot/reading/full",
  };
  const cached = getCachedReading<{
    shortReading?: string;
    longReading?: string;
    advice?: string;
    nextSteps?: string;
    questions: string[];
  }>(cacheParts);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const fallbackShort = "Le tirage révèle des énergies en transformation.";
  const fallbackLong = "Une lecture approfondie est en préparation, les cartes parlent...";
  const fallbackAdvice = "Faites confiance à votre intuition.";
  const fallbackNextSteps = "Observez les signes qui se présentent.";
  const formatPayload = (value: {
    shortReading?: string;
    longReading?: string;
    advice?: string;
    nextSteps?: string;
    questions: string[];
  }, cacheHit: boolean, generationTimeMs: number) => ({
    shortReading: truncateToWords(
      isNonEmptyString(value.shortReading) ? value.shortReading : fallbackShort,
      90,
    ),
    longReading: truncateToWords(
      isNonEmptyString(value.longReading) ? value.longReading : fallbackLong,
      220,
    ),
    advice: truncateToWords(
      isNonEmptyString(value.advice) ? value.advice : fallbackAdvice,
      45,
    ),
    nextSteps: truncateToWords(
      isNonEmptyString(value.nextSteps) ? value.nextSteps : fallbackNextSteps,
      45,
    ),
    suggestedQuestions: value.questions.slice(0, 3),
    creditsUsed: 25,
    cacheHit,
    generationTimeMs,
  });

  if (cached) {
    const result = formatPayload(cached.payload, true, 0);
    lastReadingTiming = {
      startedAt: readingStartedAt,
      generationTimeMs: 0,
      completedAt: Date.now(),
    };
    writeSse(res, "shortReading", { value: result.shortReading, complete: true });
    writeSse(res, "done", result);
    res.end();
    return;
  }

  const { systemPrompt, userPrompt } = buildFullReadingPrompts(question, cards);
  const startTime = Date.now();
  let raw = "";
  let lastShort = "";

  try {
    const stream = await gemini.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.8,
        maxOutputTokens: 8192,
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text ?? "";
      if (!text) continue;
      raw += text;
      const progress = extractJsonStringProgress(raw, "shortReading");
      if (progress && progress.value !== lastShort) {
        lastShort = progress.value;
        writeSse(res, "shortReading", {
          value: progress.value,
          complete: progress.complete,
        });
      }
    }

    const parsed = parseFullReadingResponse(raw);
    const rawShort = isNonEmptyString(parsed.shortReading) ? parsed.shortReading : fallbackShort;
    const rawLong = isNonEmptyString(parsed.longReading) ? parsed.longReading : fallbackLong;
    const rawAdvice = isNonEmptyString(parsed.advice) ? parsed.advice : fallbackAdvice;
    const rawNextSteps = isNonEmptyString(parsed.nextSteps) ? parsed.nextSteps : fallbackNextSteps;
    const cachedPayload = {
      shortReading: rawShort,
      longReading: rawLong,
      advice: rawAdvice,
      nextSteps: rawNextSteps,
      questions: parsed.questions,
    };
    setCachedReading(cacheParts, cachedPayload);

    const result = formatPayload(cachedPayload, false, Date.now() - startTime);
    const completedAt = Date.now();
    lastReadingTiming = {
      startedAt: readingStartedAt,
      generationTimeMs: result.generationTimeMs,
      completedAt,
    };
    if (result.shortReading !== lastShort) {
      writeSse(res, "shortReading", { value: result.shortReading, complete: true });
    }
    writeSse(res, "done", result);
    res.end();
    req.log?.info(
      { chars: rawShort.length + rawLong.length + rawAdvice.length + rawNextSteps.length, latencyMs: completedAt - startTime },
      "Generated full reading stream (1 LLM call, cached for replay)",
    );
  } catch (err) {
    req.log?.error({ err }, "AI tarot reading stream failed");
    writeSse(res, "error", {
      error: isQuotaError(err)
        ? "Quota IA épuisé. Vérifiez votre plan et facturation, puis réessayez."
        : "Impossible de générer la lecture pour le moment.",
    });
    res.end();
  }
});

router.post("/tarot/reading/detail", async (req, res) => {
  const payload = validateRequest(req, res);
  if (!payload) return;

  const { question, cards } = payload;
  const { systemPrompt, userPrompt } = buildDetailPrompts(question, cards);

  const startTime = Date.now();
  try {
    const parsed = await generateReadingWithRetry(
      systemPrompt,
      userPrompt,
      (content) => parseReadingResponse(content),
      req.log,
      4,
    );

    const rawLong = isNonEmptyString(parsed.longReading)
      ? parsed.longReading
      : "Une lecture approfondie est en préparation, les cartes parlent...";
    const rawAdvice = isNonEmptyString(parsed.advice)
      ? parsed.advice
      : "Faites confiance à votre intuition.";
    const rawNextSteps = isNonEmptyString(parsed.nextSteps)
      ? parsed.nextSteps
      : "Observez les signes qui se présentent.";

    const missingCardNames = cards
      .map((c) => c.name)
      .filter((name) => !rawLong.toLowerCase().includes(name.toLowerCase()));

    if (missingCardNames.length > 0) {
      req.log.warn(
        { missingCardNames, longReading: rawLong },
        "Long reading missing card names; accepting truncated response but logging",
      );
    }

    res.json({
      longReading: truncateToWords(rawLong, 140),
      advice: truncateToWords(rawAdvice, 45),
      nextSteps: truncateToWords(rawNextSteps, 45),
      creditsUsed: 50,
      generationTimeMs: Date.now() - startTime,
    });
  } catch (err) {
    handleGenerationError(err, res, req.log);
  }
});

router.post("/tarot/reading/follow-up-questions", async (req, res) => {
  const payload = validateRequest(req, res);
  if (!payload) return;

  const context = validateContext(req.body);
  if (!context) {
    res.status(400).json({ error: "Contexte de lecture manquant ou invalide." });
    return;
  }

  const { question, cards } = payload;
  const { systemPrompt, userPrompt } = buildFollowUpQuestionsPrompts(question, cards, context);

  const startTime = Date.now();
  try {
    const parsed = await generateReadingWithRetry(
      systemPrompt,
      userPrompt,
      (content) => parseFollowUpQuestionsResponse(content),
      req.log,
      3,
    );

    res.json({
      questions: parsed.questions.slice(0, 3),
      creditsUsed: 25,
      generationTimeMs: Date.now() - startTime,
    });
  } catch (err) {
    handleGenerationError(err, res, req.log);
  }
});

router.post("/tarot/reading/follow-up-detail", async (req, res) => {
  const payload = validateRequest(req, res);
  if (!payload) return;

  const context = validateContext(req.body);
  if (!context) {
    res.status(400).json({ error: "Contexte de lecture manquant ou invalide." });
    return;
  }

  const { followUpQuestion, isSuggested } = req.body as { followUpQuestion?: string; isSuggested?: boolean };
  if (!isNonEmptyString(followUpQuestion)) {
    res.status(400).json({ error: "Question de suivi manquante ou invalide." });
    return;
  }

  const followUpDetailCost = isSuggested === true ? 25 : 30;

  const { question, cards } = payload;
  const { systemPrompt, userPrompt } = buildFollowUpDetailPrompts(
    question,
    cards,
    context,
    followUpQuestion,
  );

  const startTime = Date.now();
  try {
    const parsed = await generateReadingWithRetry(
      systemPrompt,
      userPrompt,
      (content) => parseReadingResponse(content),
      req.log,
      4,
    );

    const rawLong = isNonEmptyString(parsed.longReading)
      ? parsed.longReading
      : "Une lecture approfondie est en préparation, les cartes parlent...";
    const rawAdvice = isNonEmptyString(parsed.advice)
      ? parsed.advice
      : "Faites confiance à votre intuition.";
    const rawNextSteps = isNonEmptyString(parsed.nextSteps)
      ? parsed.nextSteps
      : "Observez les signes qui se présentent.";

    res.json({
      longReading: truncateToWords(rawLong, 120),
      advice: truncateToWords(rawAdvice, 45),
      nextSteps: truncateToWords(rawNextSteps, 45),
      creditsUsed: followUpDetailCost,
      generationTimeMs: Date.now() - startTime,
    });
  } catch (err) {
    handleGenerationError(err, res, req.log);
  }
});

// ── Text-to-Speech (Gemini 2.5 Flash TTS) ─────────────────────────────────────
// Voice: Kore | Language: fr-FR | Style hint: conversationnel, calme, vitesse 1
// The Gemini preview TTS model returns raw PCM 16-bit @ 24 kHz mono. We wrap
// the bytes in a minimal 44-byte WAV container so any player (expo-audio,
// <audio>, etc.) can decode it without extra configuration.
// Free tier: 1,000,000 characters per calendar month. Tracked in-memory.
// When the monthly quota is exhausted we respond 429 so the client switches
// to the free expo-speech / Web Speech API fallback.

const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
// Voice picker — the studio voice the client requested. Defaults to
// Kore is the default for every legacy code path that does not pass `voice`.
const TTS_DEFAULT_VOICE = "Kore";
const TTS_VOICE = TTS_DEFAULT_VOICE; // alias kept for backward compatibility
export const TTS_VOICES = [
  "Kore",
  "Vindemiatrix",
  "Aoede",
  "Autonome",
  "Leda",
  "Callirrhoe",
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
function normalizeTtsVoice(raw: unknown): TtsVoice {
  if (
    typeof raw === "string" &&
    (TTS_VOICES as readonly string[]).includes(raw)
  ) {
    return raw as TtsVoice;
  }
  return TTS_DEFAULT_VOICE;
}
const TTS_LANGUAGE = "fr-FR";
// Gemini 2.5 Flash TTS emits raw 16-bit PCM for AUDIO responses. The Gemini
// generateContent API does not expose an audioEncoding switch like Cloud TTS;
// LINEAR16 is the model's native output. Keep the transport contract explicit
// here and wrap every provider chunk as a standard WAV before it leaves Node.
const TTS_AUDIO_ENCODING = "LINEAR16";
const TTS_AUDIO_MIME_TYPE = "audio/L16";
const TTS_SAMPLE_RATE = 24000;
const TTS_MONTHLY_LIMIT = 1_000_000;
const TTS_STYLE_PREFIX =
  "Instructions de style : Agis comme une femme moderne, calme, pragmatique et profondément bienveillante. Tu n'es pas une actrice, tu es une professionnelle de l'écoute. Parle avec ta voix de tous les jours : un ton conversationnel, plat, neutre et posé. Ne cherche pas à mettre du mystère, d'effet de style ou d'emphase. Ta voix doit être linéaire, rassurante et très réaliste, comme si tu parlais à un ami autour d'un café. Évite absolument les intonations dramatiques. Garde un débit strictement régulier et une vitesse naturelle de 1x. Commence chaque extrait avec exactement la même hauteur de voix, la même énergie et le même placement vocal que les autres ; ne fais pas de nouvelle introduction et ne remonte pas la voix au début d'une phrase. Les phrases doivent s'enchaîner comme une seule lecture continue. Après chaque point, marque seulement une très légère respiration naturelle, sans silence prolongé ni ralentissement artificiel. Langue : français (France). Lis uniquement le texte suivant : ";

function pcmSampleRateFromMimeType(mimeType: unknown): number {
  if (typeof mimeType === "string") {
    const match = mimeType.match(/(?:rate|sample[_-]?rate)\s*=\s*(\d+)/i);
    if (match) {
      const parsed = Number(match[1]);
      if (parsed === 16_000 || parsed === 24_000) return parsed;
    }
  }
  return TTS_SAMPLE_RATE;
}

function isLinear16MimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== "string" || !mimeType.trim()) return true;
  const normalized = mimeType.toLowerCase();
  return (
    normalized.includes("audio/l16") ||
    normalized.includes("audio/pcm") ||
    normalized.includes("audio/raw") ||
    normalized.includes("linear16")
  );
}

// ── Per-project daily quota tracking ───────────────────────────────────────
// Free-tier Gemini projects cap TTS at GenerateRequestsPerDayPerModel = 100
// per UTC-calendar-day on Pacific wall clock (resets at midnight Pacific
// per https://ai.google.dev/gemini-api/docs/rate-limits). We mirror the
// cap locally so callers can pick the next non-exhausted project without
// waiting for a 429 to arrive. Counts here are best-effort: Google counts
// every request that hits their servers, including successful ones and 429s.
type TtsProjectKey = "primary" | "backup" | "vertex";
const GEMINI_TTS_DAILY_LIMIT = 100;
const ttsDaily: Record<TtsProjectKey, { dateKey: string; count: number }> = {
  primary: { dateKey: "", count: 0 },
  backup: { dateKey: "", count: 0 },
  vertex: { dateKey: "", count: 0 },
};
const ttsRequestTimestamps: Record<TtsProjectKey, number[]> = {
  primary: [],
  backup: [],
  vertex: [],
};

function pacificDateKey(now: Date = new Date()): string {
  // Intl with en-CA + America/Los_Angeles gives sortable YYYY-MM-DD in PT.
  // Survives DST transitions since we always read the calendar day
  // Google uses for its daily quota reset window.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function refreshDaily(project: TtsProjectKey): void {
  const k = pacificDateKey();
  const s = ttsDaily[project];
  if (s.dateKey !== k) {
    s.dateKey = k;
    s.count = 0;
  }
}

function getDailyQuotaWithLimit(p: TtsProjectKey): {
  dateKey: string;
  used: number;
  limit: number;
} {
  refreshDaily(p);
  const s = ttsDaily[p];
  return { dateKey: s.dateKey, used: s.count, limit: GEMINI_TTS_DAILY_LIMIT };
}

function noteDailyRequest(project: TtsProjectKey): void {
  refreshDaily(project);
  ttsDaily[project].count += 1;
  const now = Date.now();
  const timestamps = ttsRequestTimestamps[project];
  timestamps.push(now);
  while (timestamps.length > 0 && timestamps[0] <= now - 60_000) {
    timestamps.shift();
  }
}

// Pick the project to use for the next TTS call. Vertex is preferred for
// audio, then the primary Gemini project, then the Gemini backup project.
// If all configured projects are full, return Vertex when available so the
// caller still gets the preferred provider's 429/failover behavior.
function pickInitialTtsProject(): TtsProjectKey {
  refreshDaily("primary");
  refreshDaily("backup");
  refreshDaily("vertex");
  if (geminiVertex && ttsDaily.vertex.count < GEMINI_TTS_DAILY_LIMIT) {
    return "vertex";
  }
  if (ttsDaily.primary.count < GEMINI_TTS_DAILY_LIMIT) return "primary";
  if (geminiBackup && ttsDaily.backup.count < GEMINI_TTS_DAILY_LIMIT) {
    return "backup";
  }
  if (geminiVertex) return "vertex";
  if (ttsDaily.primary.count < GEMINI_TTS_DAILY_LIMIT) return "primary";
  if (geminiBackup) return "backup";
  return "primary";
}

function nextTtsProject(project: TtsProjectKey): TtsProjectKey | null {
  if (project === "vertex") return "primary";
  if (project === "primary") return geminiBackup ? "backup" : null;
  return null;
}

function getTtsClient(project: TtsProjectKey): GoogleGenAI | null {
  return project === "primary"
    ? gemini
    : project === "backup"
      ? geminiBackup
      : geminiVertex;
}

function shouldFailoverTtsStatus(status: number): boolean {
  // A Vertex API key can be valid but lack permission for the preview TTS
  // model, which returns 403 rather than 429. Treat provider auth/model
  // failures and transient upstream failures like quota failures so one
  // misconfigured project never forces the client to expo-speech.
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

// One-shot helper: try the chosen project, then walk the configured failover
// chain on provider errors. Attempts are counted because Google counts the
// request even when it returns an error.
async function tryTtsGenerateWithFailover(
  initialProject: TtsProjectKey,
  body: Parameters<typeof gemini.models.generateContent>[0],
): Promise<
  | { ok: true; response: Awaited<ReturnType<typeof gemini.models.generateContent>>; project: TtsProjectKey }
  | { ok: false; errorStatus: number; project: TtsProjectKey }
> {
  let project: TtsProjectKey = initialProject;
  // At most three attempts: Vertex, primary, then backup.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client =
      project === "primary"
        ? gemini
        : project === "backup"
          ? geminiBackup
          : geminiVertex;
    if (!client) {
      return { ok: false, errorStatus: 503, project };
    }
    noteDailyRequest(project);
    try {
      const response = await client.models.generateContent(body);
      return { ok: true, response, project };
    } catch (err) {
      const status =
        (err as { status?: number })?.status ??
        (err as { response?: { status?: number } })?.response?.status ??
        (err as { code?: number })?.code ??
        502;
      const next = shouldFailoverTtsStatus(status)
        ? nextTtsProject(project)
        : null;
      if (next) {
        project = next;
        continue;
      }
      return { ok: false, errorStatus: status, project };
    }
  }
  // Unreachable: the loop returns on the second iteration either way.
  return { ok: false, errorStatus: 502, project };
}

interface TtsQuotaState {
  monthKey: string;
  chars: number;
  // Track tokens (input + output) so the admin "stats token tts" counter
  // matches what users see on AI Studio — the chars field is just a billing
  // convenience for our internal monthly limit, the `inputTokens` and
  // `outputTokens` mirror the SDK's `usageMetadata`.
  inputTokens: number;
  outputTokens: number;
}

const ttsQuota: TtsQuotaState = {
  monthKey: "",
  chars: 0,
  inputTokens: 0,
  outputTokens: 0,
};

// ── TTS usage log (exposed at /tarot/reading/tts/stats) ──────────────────────
interface TtsLogEntry {
  id: string;
  timestamp: number;
  chars: number;
  latencyMs: number;
  firstAudioLatencyMs?: number;
  fallback: boolean;
  textPreview: string;
  // Free-form operator hint surfaced in the admin history rows so users
  // can tell *why* a fallback fired: "quota" (server-side 429),
  // "streaming" (one or both Gemini chunks failed), or "error" (single-call
  // 5xx). When `fallback === false`, `reason` stays unset.
  reason?: string;
}

const TTS_LOG_LIMIT = 200;
const ttsLog: TtsLogEntry[] = [];
interface TtsClientMetric {
  id: string;
  timestamp: number;
  chars: number;
  textPreview: string;
  oracleToFirstAudioMs: number;
  preparationMs?: number;
  cacheHit: boolean;
  source: "gemini" | "expo-speech";
}
const TTS_CLIENT_METRIC_LIMIT = 200;
const ttsClientMetrics: TtsClientMetric[] = [];

let ttsLogCounter = 0;
function pushTtsLog(
  entry: Omit<TtsLogEntry, "id">,
): TtsLogEntry {
  const id = `tts-${Date.now().toString(36)}-${(ttsLogCounter++).toString(36)}`;
  const full: TtsLogEntry = { id, ...entry };
  ttsLog.unshift(full);
  if (ttsLog.length > TTS_LOG_LIMIT) ttsLog.length = TTS_LOG_LIMIT;
  return full;
}

function makeTtsPreview(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getTtsQuota(): TtsQuotaState {
  const key = currentMonthKey();
  if (ttsQuota.monthKey !== key) {
    ttsQuota.monthKey = key;
    ttsQuota.chars = 0;
    ttsQuota.inputTokens = 0;
    ttsQuota.outputTokens = 0;
  }
  return ttsQuota;
}

function wavHeader(pcmLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono channel
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit × 1 channel)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

function streamingWavHeader(sampleRate: number): Buffer {
  // The stream has no known final PCM length. The mobile/web clients consume
  // the bytes after this header incrementally, while native media decoders can
  // still identify the stream as mono 16-bit PCM at 24 kHz.
  const header = wavHeader(0xffffffff - 36, sampleRate);
  header.writeUInt32LE(0xffffffff, 4);
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

const handleTtsStream = async (req: any, res: any) => {
  const body = req.method === "GET" ? req.query ?? {} : req.body ?? {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Text is required for TTS." });
    return;
  }

  const voice = normalizeTtsVoice(body.voice);
  const quota = getTtsQuota();
  if (quota.chars + text.length > TTS_MONTHLY_LIMIT) {
    res.status(429).json({
      error: "TTS monthly quota exhausted.",
      charsUsed: quota.chars,
      charsLimit: TTS_MONTHLY_LIMIT,
      fallbackRequired: true,
    });
    return;
  }

  const startTime = Date.now();
  let project = pickInitialTtsProject();
  try {
    let stream: Awaited<
      ReturnType<GoogleGenAI["models"]["generateContentStream"]>
    > | null = null;

    for (let attempt = 0; attempt < 3 && !stream; attempt += 1) {
      const client = getTtsClient(project);
      if (!client) {
        const next = nextTtsProject(project);
        if (!next) break;
        project = next;
        continue;
      }
      noteDailyRequest(project);
      try {
        stream = await client.models.generateContentStream({
          model: GEMINI_TTS_MODEL,
          contents: [
            {
              role: "user",
              parts: [{
                text: TTS_STYLE_PREFIX + text,
              }],
            },
          ],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        });
      } catch (err) {
        const status =
          (err as { status?: number })?.status ??
          (err as { response?: { status?: number } })?.response?.status ??
          (err as { code?: number })?.code ??
          502;
        const next = shouldFailoverTtsStatus(status)
          ? nextTtsProject(project)
          : null;
        if (!next) throw err;
        req.log?.warn?.(
          { project, next, status },
          "TTS stream provider failed; trying failover",
        );
        project = next;
      }
    }

    if (!stream) {
      throw new Error("No TTS provider is configured.");
    }

    res.status(200);
    res.setHeader("Content-Type", "audio/x-wav");
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders?.();
    res.write(streamingWavHeader(TTS_SAMPLE_RATE));

    let pcmBytes = 0;
    let firstAudioLatencyMs: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      const parts = (chunk.candidates?.[0]?.content?.parts ?? []) as Array<{
        inlineData?: { mimeType?: string; data?: string };
      }>;
      const audioPart = parts.find((part) => part.inlineData?.data);
      if (audioPart?.inlineData?.data) {
        if (firstAudioLatencyMs === undefined) {
          firstAudioLatencyMs = Date.now() - startTime;
        }
        const mimeType = audioPart.inlineData.mimeType;
        if (!isLinear16MimeType(mimeType)) {
          throw new Error(`Unsupported Gemini TTS audio format: ${mimeType}`);
        }
        const sampleRate = pcmSampleRateFromMimeType(mimeType);
        const pcm = Buffer.from(audioPart.inlineData.data, "base64");
        pcmBytes += pcm.length;
        // The web stream keeps one stream-level header. Gemini TTS currently
        // emits 24 kHz LINEAR16; use the MIME metadata if a provider returns
        // the supported 16 kHz variant instead.
        if (sampleRate !== TTS_SAMPLE_RATE) {
          req.log?.warn?.({ sampleRate, mimeType }, "Gemini TTS sample rate differs from default");
        }
        res.write(pcm);
      }
      inputTokens += chunk.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += chunk.usageMetadata?.candidatesTokenCount ?? 0;
    }
    res.end();

    quota.chars += text.length;
    quota.inputTokens += inputTokens;
    quota.outputTokens += outputTokens;
    pushTtsLog({
      timestamp: Date.now(),
      chars: text.length,
      latencyMs: Date.now() - startTime,
      firstAudioLatencyMs,
      fallback: false,
      textPreview: makeTtsPreview(text),
    });
    req.log?.info(
      { chars: text.length, pcmBytes, voice, project, generationTimeMs: Date.now() - startTime },
      "TTS audio stream completed",
    );
  } catch (err) {
    req.log?.error({ err, project }, "TTS audio stream failed");
    if (!res.headersSent) {
      res.status(502).json({
        error: "TTS streaming failed.",
        fallbackRequired: true,
        detail: err instanceof Error ? err.message : String(err),
      });
    } else {
      res.destroy(err instanceof Error ? err : undefined);
    }
  }
};

router.post("/tarot/reading/tts/stream", handleTtsStream);
router.get("/tarot/reading/tts/stream", handleTtsStream);

// Android cannot reliably decode an open-ended WAV. This transport keeps the
// Gemini stream progressive but frames every PCM chunk as a complete short WAV
// and sends it as SSE/base64, which expo/fetch can consume natively.
router.post("/tarot/reading/tts/android-stream", async (req, res) => {
  const body = req.body ?? {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Text is required for TTS." });
    return;
  }

  const voice = normalizeTtsVoice(body.voice);
  const quota = getTtsQuota();
  if (quota.chars + text.length > TTS_MONTHLY_LIMIT) {
    res.status(429).json({
      error: "TTS monthly quota exhausted.",
      charsUsed: quota.chars,
      charsLimit: TTS_MONTHLY_LIMIT,
      fallbackRequired: true,
    });
    return;
  }

  const startTime = Date.now();
  let project = pickInitialTtsProject();
  try {
    let stream: Awaited<
      ReturnType<GoogleGenAI["models"]["generateContentStream"]>
    > | null = null;
    for (let attempt = 0; attempt < 3 && !stream; attempt += 1) {
      const client = getTtsClient(project);
      if (!client) {
        const next = nextTtsProject(project);
        if (!next) break;
        project = next;
        continue;
      }
      noteDailyRequest(project);
      try {
        stream = await client.models.generateContentStream({
          model: GEMINI_TTS_MODEL,
          contents: [{
            role: "user",
            parts: [{ text: TTS_STYLE_PREFIX + text }],
          }],
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        });
      } catch (err) {
        const status =
          (err as { status?: number })?.status ??
          (err as { response?: { status?: number } })?.response?.status ??
          (err as { code?: number })?.code ??
          502;
        const next = shouldFailoverTtsStatus(status) ? nextTtsProject(project) : null;
        if (!next) throw err;
        project = next;
      }
    }
    if (!stream) throw new Error("No TTS provider is configured.");

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    writeSse(res, "ready", {
      sampleRate: TTS_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      encoding: TTS_AUDIO_ENCODING,
      mimeType: TTS_AUDIO_MIME_TYPE,
      format: "wav-pcm16-mono",
    });
    let pcmBytes = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let sequence = 0;
    let firstAudioLatencyMs: number | undefined;
    for await (const chunk of stream) {
      const parts = (chunk.candidates?.[0]?.content?.parts ?? []) as Array<{
        inlineData?: { data?: string; mimeType?: string };
      }>;
      const audioPart = parts.find((part) => part.inlineData?.data);
      if (audioPart?.inlineData?.data) {
        if (firstAudioLatencyMs === undefined) {
          firstAudioLatencyMs = Date.now() - startTime;
        }
        const mimeType = audioPart.inlineData.mimeType;
        if (!isLinear16MimeType(mimeType)) {
          throw new Error(`Unsupported Gemini TTS audio format: ${mimeType}`);
        }
        const sampleRate = pcmSampleRateFromMimeType(mimeType);
        const rawPcm = Buffer.from(audioPart.inlineData.data, "base64");
        // PCM16 frames must contain complete 2-byte samples. Discard one
        // provider padding byte rather than sending it to Android, where it
        // can become an audible burst of static at the end of playback.
        const pcm = rawPcm.subarray(0, rawPcm.length & ~1);
        if (pcm.length === 0) continue;
        pcmBytes += pcm.length;
        const wav = Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
        writeSse(res, "audio", {
          sequence,
          sampleRate,
          encoding: TTS_AUDIO_ENCODING,
          mimeType: TTS_AUDIO_MIME_TYPE,
          durationMs: Math.max(1, Math.round((pcm.length / (sampleRate * 2)) * 1000)),
          audioBase64: wav.toString("base64"),
        });
        if (firstAudioLatencyMs !== undefined && sequence === 0) {
          req.log?.info(
            { chars: text.length, firstAudioLatencyMs, project, voice },
            "First Android TTS audio emitted",
          );
        }
        sequence += 1;
      }
      inputTokens += chunk.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += chunk.usageMetadata?.candidatesTokenCount ?? 0;
    }

    quota.chars += text.length;
    quota.inputTokens += inputTokens;
    quota.outputTokens += outputTokens;
    pushTtsLog({
      timestamp: Date.now(),
      chars: text.length,
      latencyMs: Date.now() - startTime,
      firstAudioLatencyMs,
      fallback: false,
      textPreview: makeTtsPreview(text),
    });
    writeSse(res, "done", {
      chars: text.length,
      charsUsed: quota.chars,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens,
      outputTokens,
      voice,
      model: GEMINI_TTS_MODEL,
      segments: sequence,
    });
    res.end();
  } catch (err) {
    req.log?.error({ err, project }, "Android TTS stream failed");
    if (!res.headersSent) {
      res.status(502).json({
        error: "TTS streaming failed.",
        fallbackRequired: true,
      });
    } else {
      writeSse(res, "error", { error: "TTS streaming failed.", fallbackRequired: true });
      res.end();
    }
  }
});

router.post("/tarot/reading/tts", async (req, res) => {
  const body = req.body ?? {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Text is required for TTS." });
    return;
  }
  // Voice picker — clients can ask for any voice in the TTS_VOICES
  // allowlist. Unknown values fall back to the default (Kore).
  // The selected voice is propagated into both chunk responses, the
  // monthly quota audit, and the in-memory log so the admin dashboard
  // can see exactly which voice is in rotation per playback.
  const voice = normalizeTtsVoice(body.voice);

  // Always synthesize the complete reading as one WAV. Segmenting the
  // response into separate files creates an audible pause between them.
  const audioText = text;
  const charCount = audioText.length;
  const billableChars = charCount;
  const quota = getTtsQuota();
  if (quota.chars + billableChars > TTS_MONTHLY_LIMIT) {
    req.log?.info(
      { charsUsed: quota.chars, requested: billableChars },
      "TTS monthly quota exhausted — signaling client to use fallback",
    );
    pushTtsLog({
      timestamp: Date.now(),
      chars: charCount,
      latencyMs: 0,
      fallback: true,
      textPreview: makeTtsPreview(text),
      reason: "quota",
    });
    res.status(429).json({
      error: "TTS monthly quota exhausted.",
      charsUsed: quota.chars,
      charsLimit: TTS_MONTHLY_LIMIT,
      fallbackRequired: true,
    });
    return;
  }

  const charCountForSingleCall = audioText.length;
  const startTime = Date.now();
  try {
    const result = await tryTtsGenerateWithFailover(
      pickInitialTtsProject(),
      {
        model: GEMINI_TTS_MODEL,
        contents: [
          { role: "user", parts: [{ text: TTS_STYLE_PREFIX + audioText }] },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      },
    );
    if (!result.ok) {
      req.log?.error(
        { errStatus: result.errorStatus, project: result.project },
        "TTS generation failed",
      );
      // Re-throw so the existing 502 catch branch runs unchanged —
      // keeps pushTtsLog(reason:'error') + res.status(502) flow.
      throw new Error(`TTS generation failed (status ${result.errorStatus})`);
    }
    const response = result.response;

    type AudioPart = { inlineData?: { mimeType?: string; data?: string } };
    const candidate = response.candidates?.[0];
    const parts = (candidate?.content?.parts ?? []) as AudioPart[];
    // Gemini can omit inlineData.mimeType on the non-streaming response even
    // though the payload is the configured PCM audio. The stream endpoint
    // already accepts any inlineData payload; keep both paths consistent.
    const audioPart = parts.find((p) => p.inlineData?.data);
    if (!audioPart?.inlineData?.data) {
      throw new Error("Gemini TTS response did not contain audio data.");
    }

    // Gemini returns PCM16. Keep only complete samples so a provider padding
    // byte can never become a click at a WAV boundary.
    const rawPcmBuffer = Buffer.from(audioPart.inlineData.data, "base64");
    const pcmBuffer = rawPcmBuffer.subarray(0, rawPcmBuffer.length & ~1);
    if (pcmBuffer.length === 0) {
      throw new Error("Gemini TTS response contained no complete PCM samples.");
    }
    const wavBuffer = Buffer.concat([wavHeader(pcmBuffer.length, TTS_SAMPLE_RATE), pcmBuffer]);

    const meta = response.usageMetadata;
    const inputTokens = meta?.promptTokenCount ?? 0;
    const outputTokens = meta?.candidatesTokenCount ?? 0;
    quota.chars += charCount;
    quota.inputTokens += inputTokens;
    quota.outputTokens += outputTokens;
    const generationTimeMs = Date.now() - startTime;
    req.log?.info(
      { chars: charCount, charsUsed: quota.chars, voice, generationTimeMs },
      "TTS audio generated",
    );

    pushTtsLog({
      timestamp: Date.now(),
      chars: charCount,
      latencyMs: generationTimeMs,
      fallback: false,
      textPreview: makeTtsPreview(text),
    });

    res.json({
      audioBase64: wavBuffer.toString("base64"),
      mime: "audio/wav",
      sampleRate: TTS_SAMPLE_RATE,
      voice,
      language: TTS_LANGUAGE,
      model: GEMINI_TTS_MODEL,
      chars: charCount,
      charsUsed: quota.chars,
      charsLimit: TTS_MONTHLY_LIMIT,
      inputTokens,
      outputTokens,
      inputTokensUsed: quota.inputTokens,
      outputTokensUsed: quota.outputTokens,
      generationTimeMs,
    });
  } catch (err) {
    req.log?.error({ err }, "TTS generation failed");
    pushTtsLog({
      timestamp: Date.now(),
      chars: charCount,
      latencyMs: Date.now() - startTime,
      fallback: true,
      textPreview: makeTtsPreview(text),
      reason: "error",
    });
    res.status(502).json({
      error: "TTS generation failed.",
      fallbackRequired: true,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── TTS admin stats: usage, latency, fallback rate, recent plays ─────────────
router.get("/tarot/reading/tts/stats", (_req, res) => {
  const quota = getTtsQuota();
  const fallbackCount = ttsLog.filter((e) => e.fallback).length;
  const totalCount = ttsLog.length;
  const avgLatencyMs =
    totalCount === 0
      ? 0
      : Math.round(
          ttsLog.reduce((acc, e) => acc + e.latencyMs, 0) / totalCount,
        );
  const firstAudioEntries = ttsLog.filter(
    (entry) => typeof entry.firstAudioLatencyMs === "number",
  );
  const avgFirstAudioLatencyMs =
    firstAudioEntries.length === 0
      ? 0
      : Math.round(
          firstAudioEntries.reduce(
            (acc, entry) => acc + (entry.firstAudioLatencyMs ?? 0),
            0,
          ) / firstAudioEntries.length,
        );
  const clientMetricPreparationEntries = ttsClientMetrics.filter(
    (entry) => typeof entry.preparationMs === "number",
  );
  const avgOracleToFirstAudioMs =
    ttsClientMetrics.length === 0
      ? 0
      : Math.round(
          ttsClientMetrics.reduce(
            (acc, entry) => acc + entry.oracleToFirstAudioMs,
            0,
          ) / ttsClientMetrics.length,
        );
  const avgClientPreparationMs =
    clientMetricPreparationEntries.length === 0
      ? 0
      : Math.round(
          clientMetricPreparationEntries.reduce(
            (acc, entry) => acc + (entry.preparationMs ?? 0),
            0,
          ) / clientMetricPreparationEntries.length,
        );
  const now = Date.now();
  const rpm = (Object.keys(ttsRequestTimestamps) as TtsProjectKey[]).reduce(
    (acc, project) => {
      const timestamps = ttsRequestTimestamps[project];
      while (timestamps.length > 0 && timestamps[0] <= now - 60_000) {
        timestamps.shift();
      }
      acc[project] = timestamps.length;
      return acc;
    },
    {} as Record<TtsProjectKey, number>,
  );
  const lastReadingTts = lastReadingTiming
    ? ttsLog
        .filter((entry) => entry.timestamp >= lastReadingTiming!.startedAt)
        .sort((a, b) => a.timestamp - b.timestamp)
    : [];
  res.json({
    lastReading: lastReadingTiming
      ? {
          generationTimeMs: lastReadingTiming.generationTimeMs,
          tts: lastReadingTts.map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            chars: entry.chars,
            firstAudioLatencyMs: entry.firstAudioLatencyMs,
            fallback: entry.fallback,
          })),
        }
      : null,
    quota: {
      monthKey: quota.monthKey,
      chars: quota.chars,
      limit: TTS_MONTHLY_LIMIT,
      inputTokens: quota.inputTokens,
      outputTokens: quota.outputTokens,
      percent:
        quota.chars === 0
          ? 0
          : Math.min(100, (quota.chars / TTS_MONTHLY_LIMIT) * 100),
    },
    voice: TTS_VOICE,
    model: GEMINI_TTS_MODEL,
    language: TTS_LANGUAGE,
    totalCount,
    fallbackCount,
    fallbackRate: totalCount === 0 ? 0 : (fallbackCount / totalCount) * 100,
    avgLatencyMs,
    avgFirstAudioLatencyMs,
    clientMetrics: {
      count: ttsClientMetrics.length,
      avgOracleToFirstAudioMs,
      avgPreparationMs: avgClientPreparationMs,
      recent: ttsClientMetrics.slice(0, 50),
    },
    rpm: {
      total: rpm.primary + rpm.backup + rpm.vertex,
      primary: rpm.primary,
      backup: geminiBackup ? rpm.backup : null,
      vertex: geminiVertex ? rpm.vertex : null,
      windowSeconds: 60,
    },
    daily: {
      primary: getDailyQuotaWithLimit("primary"),
      backup: geminiBackup ? getDailyQuotaWithLimit("backup") : null,
      vertex: geminiVertex ? getDailyQuotaWithLimit("vertex") : null,
      limit: GEMINI_TTS_DAILY_LIMIT,
      thresholdPct: 80,
    },
    projects: geminiBackup || geminiVertex
      ? {
          active: pickInitialTtsProject(),
          note:
            "Le serveur bascule automatiquement sur les projets secours quand le principal atteint son plafond quotidien.",
        }
      : {
          active: "primary",
          note:
            "Aucun projet de secours configuré — ajoute GEMINI_API_KEY_BACKUP ou VERTEX_AI_API_KEY côté serveur pour augmenter le quota quotidien.",
        },
    recent: ttsLog.slice(0, 50),
  });
});

// Client-side timing is intentionally kept separate from server generation
// logs: it measures the experience from the moment the Oracle is visible to
// the moment the native player starts the first complete WAV.
router.post("/tarot/reading/tts/client-metrics", (req, res) => {
  const body = req.body as Partial<TtsClientMetric> | null;
  if (
    !body ||
    typeof body.oracleToFirstAudioMs !== "number" ||
    !Number.isFinite(body.oracleToFirstAudioMs) ||
    body.oracleToFirstAudioMs < 0 ||
    body.oracleToFirstAudioMs > 300_000 ||
    typeof body.chars !== "number" ||
    !Number.isFinite(body.chars) ||
    body.chars < 1 ||
    typeof body.textPreview !== "string" ||
    typeof body.cacheHit !== "boolean" ||
    (body.source !== "gemini" && body.source !== "expo-speech")
  ) {
    res.status(400).json({ error: "Mesure audio invalide." });
    return;
  }
  const metric: TtsClientMetric = {
    id: `tts-client-${Date.now().toString(36)}-${(ttsLogCounter++).toString(36)}`,
    timestamp: Date.now(),
    chars: Math.round(body.chars),
    textPreview: makeTtsPreview(body.textPreview, 80),
    oracleToFirstAudioMs: Math.round(body.oracleToFirstAudioMs),
    preparationMs:
      typeof body.preparationMs === "number" && Number.isFinite(body.preparationMs)
        ? Math.max(0, Math.round(body.preparationMs))
        : undefined,
    cacheHit: body.cacheHit,
    source: body.source,
  };
  ttsClientMetrics.unshift(metric);
  if (ttsClientMetrics.length > TTS_CLIENT_METRIC_LIMIT) {
    ttsClientMetrics.length = TTS_CLIENT_METRIC_LIMIT;
  }
  res.status(201).json({ ok: true, id: metric.id });
});

export default router;
