import { Router } from "express";
import { db } from "@workspace/db";
import { usageEventsTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";

const router = Router();

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 heure

function getAdminPassword(): string {
  const env = process.env.ADMIN_PASSWORD;
  if (env) return env;
  if (process.env.NODE_ENV === "development") {
    // En dev uniquement, autoriser un mot de passe par défaut connu pour
    // simplifier les tests. Ne jamais laisser ce fallback en production.
    return "oracle-admin-dev";
  }
  throw new Error("ADMIN_PASSWORD must be set in production");
}

function getSessionSecret(): string {
  const env = process.env.SESSION_SECRET;
  if (!env) {
    throw new Error("SESSION_SECRET must be set to sign admin tokens");
  }
  return env;
}

function createAdminToken(): string {
  const secret = getSessionSecret();
  const payload = {
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

function verifyAdminToken(token: string): boolean {
  try {
    const secret = getSessionSecret();
    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return false;
    const expected = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(signature, "base64url"), Buffer.from(expected, "base64url"))) {
      return false;
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as { exp: number };
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

function isAdminRoute(req: { method: string; path: string }): boolean {
  // POST /admin/login délivre le jeton admin, il ne doit pas être protégé.
  // POST /stats/events est appelé depuis l'écran principal pour enregistrer
  // une utilisation normale.
  if (req.method === "POST" && req.path === "/admin/login") return false;
  if (req.method === "POST" && req.path === "/stats/events") return false;
  return true;
}

router.use((req, res, next) => {
  if (!isAdminRoute({ method: req.method, path: req.path })) {
    next();
    return;
  }

  const auth = req.headers.authorization;
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !verifyAdminToken(token)) {
    res.status(401).json({ error: "Accès admin non autorisé." });
    return;
  }
  next();
});

const loginSchema = z.object({
  password: z.string().min(1),
});

router.post("/admin/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Mot de passe requis." });
    return;
  }

  try {
    const adminPassword = getAdminPassword();
    if (parsed.data.password !== adminPassword) {
      res.status(401).json({ error: "Mot de passe incorrect." });
      return;
    }
    res.json({ token: createAdminToken() });
  } catch (err) {
    req.log.error({ err }, "Failed to create admin token");
    res.status(500).json({ error: "Impossible de créer le jeton admin." });
  }
});

const responseTypeSchema = z.enum([
  "short",
  "detail",
  "follow_up_questions",
  "follow_up_detail",
]);

const usageEventSchema = z.object({
  responseType: responseTypeSchema,
  question: z.string().min(1).max(2000),
  creditsUsed: z.number().int().min(0),
  generationTimeMs: z.number().int().min(0),
});

function getStartOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getStartOfWeek(): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day;
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

interface StatsBucket {
  shortReadings: number;
  detailReadings: number;
  totalDraws: number;
  creditsUsed: number;
  avgGenerationTimeMs: number;
}

function computeBucket(
  events: { responseType: string; creditsUsed: number; generationTimeMs: number; createdAt: Date }[],
  from: Date,
): StatsBucket {
  const bucket = events.filter((e) => e.createdAt >= from);
  const shortReadings = bucket.filter((e) => e.responseType === "short").length;
  const detailReadings = bucket.filter((e) => e.responseType === "detail").length;
  const totalDraws = bucket.length;
  const creditsUsed = bucket.reduce((sum, e) => sum + e.creditsUsed, 0);
  const generationTimeTotal = bucket.reduce((sum, e) => sum + e.generationTimeMs, 0);
  const avgGenerationTimeMs = bucket.length > 0 ? Math.round(generationTimeTotal / bucket.length) : 0;

  return { shortReadings, detailReadings, totalDraws, creditsUsed, avgGenerationTimeMs };
}

router.post("/stats/events", async (req, res) => {
  const parsed = usageEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Données d'événement invalides." });
    return;
  }

  try {
    const [event] = await db
      .insert(usageEventsTable)
      .values(parsed.data)
      .returning();

    res.status(201).json({
      id: String(event.id),
      date: event.createdAt.toISOString(),
      responseType: event.responseType,
      question: event.question,
      creditsUsed: event.creditsUsed,
      generationTimeMs: event.generationTimeMs,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to record usage event");
    res.status(500).json({ error: "Impossible d'enregistrer l'événement." });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const events = await db
      .select({
        id: usageEventsTable.id,
        createdAt: usageEventsTable.createdAt,
        responseType: usageEventsTable.responseType,
        question: usageEventsTable.question,
        creditsUsed: usageEventsTable.creditsUsed,
        generationTimeMs: usageEventsTable.generationTimeMs,
      })
      .from(usageEventsTable)
      .orderBy(desc(usageEventsTable.createdAt));

    const todayStart = getStartOfDay();
    const weekStart = getStartOfWeek();

    const stats = {
      today: computeBucket(events, todayStart),
      thisWeek: computeBucket(events, weekStart),
      allTime: computeBucket(events, new Date(0)),
      totalEvents: events.length,
    };

    const history = events.map((e) => ({
      id: String(e.id),
      date: e.createdAt.toISOString(),
      question: e.question,
      responseType: e.responseType as
        | "short"
        | "detail"
        | "follow_up_questions"
        | "follow_up_detail",
      creditsUsed: e.creditsUsed,
      generationTimeMs: e.generationTimeMs,
    }));

    res.json({ stats, history });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch stats");
    res.status(500).json({ error: "Impossible de récupérer les statistiques." });
  }
});

router.delete("/stats", async (req, res) => {
  try {
    await db.delete(usageEventsTable);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to clear stats");
    res.status(500).json({ error: "Impossible de réinitialiser les statistiques." });
  }
});

export default router;
