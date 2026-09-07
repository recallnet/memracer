/**
 * HTTP routes for Stripe (webhook before express.json; checkout/portal via dashboard).
 */

import type { Express, Request, Response } from "express";
import express from "express";
import type { Db } from "../db/driver.js";
import { applyStripeEvent } from "./webhooks.js";
import { constructWebhookEvent, stripeFromEnv } from "./stripe.js";

export function registerStripeRoutes(app: Express, db: Db): void {
  app.post(
    "/api/stripe/webhooks",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const stripe = stripeFromEnv(process.env);
      if (!stripe) {
        res.status(503).json({ error: "Stripe is not configured" });
        return;
      }
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") {
        res.status(400).json({ error: "missing stripe-signature" });
        return;
      }
      const raw = req.body;
      if (!Buffer.isBuffer(raw) && typeof raw !== "string") {
        res.status(400).json({ error: "expected raw body" });
        return;
      }
      let event;
      try {
        event = constructWebhookEvent(stripe, raw, signature, process.env);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "invalid signature" });
        return;
      }
      try {
        const result = await applyStripeEvent(db, event, process.env);
        res.json({ received: true, ...result });
      } catch (err) {
        console.error("[stripe-webhook]", err instanceof Error ? err.message : err);
        res.status(500).json({ error: "webhook handler failed" });
      }
    },
  );
}
