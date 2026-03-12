import { Router, Request, Response } from 'express';
import { mondayWebhookAuth } from '../middleware/mondayAuth';
import { logger } from '../logger';
import { applyPayment } from '../services/paymentAllocation';
import { ACTUAL_PAYMENTS } from '../config/config';

const router = Router();

/** In-memory idempotency: skip duplicate webhooks within 5 minutes */
const processedWebhooks = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function getIdempotencyKey(event: { pulseId?: number; itemId?: number; triggerTime?: string; boardId?: number }): string {
  const id = event.pulseId ?? event.itemId ?? 'unknown';
  const time = event.triggerTime ?? '';
  const board = event.boardId ?? '';
  return `${board}:${id}:${time}`;
}

function isDuplicateWebhook(event: Record<string, unknown>): boolean {
  const key = getIdempotencyKey(event as Parameters<typeof getIdempotencyKey>[0]);
  const now = Date.now();
  if (processedWebhooks.has(key)) {
    return true;
  }
  processedWebhooks.set(key, now);
  for (const [k, t] of processedWebhooks) {
    if (now - t > IDEMPOTENCY_TTL_MS) processedWebhooks.delete(k);
  }
  return false;
}

function getActualPaymentItemId(event: Record<string, unknown>): string | null {
  const id = event.pulseId ?? event.itemId;
  if (id != null) return String(id);
  return null;
}

const applyPaymentHandler = async (req: Request, res: Response) => {
  const body = req.body;

  if (body.challenge) {
    logger.info('Webhook challenge received');
    return res.status(200).json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event) {
    logger.warn('Missing event in webhook payload');
    return res.status(400).send({ error: 'Missing event payload' });
  }

  const boardId = event.boardId ?? event.board_id;
  if (boardId != null && String(boardId) !== ACTUAL_PAYMENTS.boardId) {
    logger.info('Webhook from non-Actual-Payments board, ignoring', { boardId });
    return res.status(200).json({ received: true, skipped: 'wrong_board' });
  }

  if (isDuplicateWebhook(event)) {
    logger.info('Duplicate webhook, skipping', { event });
    return res.status(200).json({ received: true, skipped: 'duplicate' });
  }

  const itemId = getActualPaymentItemId(event);
  if (!itemId) {
    logger.warn('Webhook event has no pulseId/itemId');
    return res.status(400).send({ error: 'Missing item ID in webhook' });
  }

  logger.info('Applying payment for actual payment item', { itemId });

  try {
    const result = await applyPayment({ actualPaymentItemId: itemId });
    if (result.success) {
      return res.status(200).json({
        received: true,
        subitemsCreated: result.subitemsCreated,
      });
    }
    logger.warn('Payment application failed', { itemId, error: result.error });
    return res.status(400).json({ error: result.error });
  } catch (err) {
    logger.warn('Payment application error', { itemId, err });
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
};

router.post('/apply-payment', mondayWebhookAuth, applyPaymentHandler);
router.post('/apply-payment/', mondayWebhookAuth, applyPaymentHandler);

export default router;
