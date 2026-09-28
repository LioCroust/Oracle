import { pgTable, integer, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const deviceBonusEntitlementsTable = pgTable("device_bonus_entitlements", {
  deviceId: text("device_id").primaryKey(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  bonusGranted: boolean("bonus_granted").notNull().default(true),
});

export const insertDeviceBonusEntitlementSchema = createInsertSchema(
  deviceBonusEntitlementsTable,
).omit({ grantedAt: true });

export type InsertDeviceBonusEntitlement = z.infer<
  typeof insertDeviceBonusEntitlementSchema
>;
export type DeviceBonusEntitlement = typeof deviceBonusEntitlementsTable.$inferSelect;

export const usageEventsTable = pgTable("usage_events", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  responseType: text("response_type").notNull(),
  question: text("question").notNull(),
  creditsUsed: integer("credits_used").notNull(),
  generationTimeMs: integer("generation_time_ms").notNull(),
});

export const insertUsageEventSchema = createInsertSchema(usageEventsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertUsageEvent = z.infer<typeof insertUsageEventSchema>;
export type UsageEvent = typeof usageEventsTable.$inferSelect;
