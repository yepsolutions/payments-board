import { Router, Request, Response } from "express";
import { mondayWebhookAuth } from "../middleware/mondayAuth";

const router = Router();

/**
 * Monday.com webhook endpoint for apply-payment actions.
 * Configure this URL in Monday: https://your-domain.com/actions/apply-payment/
 *
 * Handles:
 * - Challenge: When Monday sends { challenge: "..." }, responds with the same challenge
 * - Event payloads: Receives amortization payment clearance events from the subitems board
 */
const applyPaymentHandler = (req: Request, res: Response) => {
  // Monday challenge verification: echo back the challenge
  const reqWithChallenge = req as Request & { isMondayChallenge?: boolean };
  if (reqWithChallenge.isMondayChallenge && req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // Process webhook event
  const event = req.body?.event;
  if (!event) {
    return res.status(400).json({ error: "Missing event payload" });
  }

  // TODO: Implement payment application logic (step by step)
  console.log("Apply payment webhook received:", JSON.stringify(event, null, 2));

  res.status(200).json({ received: true });
};

router.post("/apply-payment", mondayWebhookAuth, applyPaymentHandler);
router.post("/apply-payment/", mondayWebhookAuth, applyPaymentHandler);

export default router;
