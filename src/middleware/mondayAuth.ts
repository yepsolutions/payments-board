import { Request, Response, NextFunction } from "express";

export function mondayWebhookAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Challenge verification: Monday sends { challenge: "..." } when setting up webhook
  if (req.body && typeof req.body.challenge === "string") {
    // Let the route handler respond with the challenge
    (req as Request & { isMondayChallenge?: boolean }).isMondayChallenge = true;
  }

  const signingSecret = process.env.MONDAY_SIGNING_SECRET;
  if (signingSecret) {
    const signature = req.headers["x-monday-signature"] as string | undefined;
    if (signature) {
      // Verify HMAC if your Monday app integration provides it
      // Standard board webhooks do not send signatures; app integrations may
      const isValid = verifySignature(
        JSON.stringify(req.body),
        signature,
        signingSecret
      );
      if (!isValid) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }
  }

  next();
}

function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    const crypto = require("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}
