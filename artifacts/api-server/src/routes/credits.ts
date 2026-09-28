import { Router } from "express";
import { db } from "@workspace/db";
import { deviceBonusEntitlementsTable } from "@workspace/db/schema";
import { z } from "zod";

const router = Router();

const deviceIdSchema = z.object({
  deviceId: z.string().min(1).max(128),
});

router.post("/credits/claim-bonus", async (req, res) => {
  const parsed = deviceIdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "deviceId invalide ou manquant." });
    return;
  }

  const { deviceId } = parsed.data;
  try {
    // Atomic claim : insert de l'entitlement. Si elle existe déjà, on sait que le bonus a déjà été accordé.
    const inserted = await db
      .insert(deviceBonusEntitlementsTable)
      .values({ deviceId, bonusGranted: true })
      .onConflictDoNothing({ target: deviceBonusEntitlementsTable.deviceId })
      .returning({ bonusGranted: deviceBonusEntitlementsTable.bonusGranted });

    const newlyGranted = inserted.length > 0;
    res.json({ granted: true, newlyGranted });
  } catch (err) {
    req.log.error({ err, deviceId }, "Failed to claim bonus entitlement");
    res.status(500).json({ error: "Impossible de traiter la demande de bonus." });
  }
});

export default router;
