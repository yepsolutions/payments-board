import { Router, Request, Response } from 'express';
import { mondayWebhookAuth } from '../middleware/mondayAuth';
import { logger } from '../logger';
import { applyPayment } from '../services/paymentAllocation';
import { ACTUAL_PAYMENTS } from '../config/config';
import { fetchCbsIndex, getLatestConstructionIndex, CBS_INDEX_CODES } from '../services/cbsApi';
import { createIndexItem, fillConstructionIndex } from '../services/indexBoard';
import { INDEX_BOARD } from '../config/config';

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

router.post('/apply-payment', mondayWebhookAuth, applyPaymentHandler);
router.post('/apply-payment/', mondayWebhookAuth, applyPaymentHandler);
async function applyPaymentHandler(req: Request, res: Response) {
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
}

router.post('/fill-construction-index', fillConstructionIndexHandler);
async function fillConstructionIndexHandler(req: Request, res: Response) {
  if (req.body?.challenge) {
    logger.info('fill-construction-index: webhook challenge received');
    return res.status(200).json({ challenge: req.body.challenge });
  }

  try {
    logger.info('fill-construction-index: starting');
    const result = await fillConstructionIndex();
    if (result.success) {
      return res.status(200).json({
        success: true,
        created: result.created,
        updated: result.updated,
      });
    }
    return res.status(502).json({
      success: false,
      error: result.error,
    });
  } catch (err) {
    logger.warn('fill-construction-index error', { err });
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
}

router.post('/get-index', getIndexHandler);
async function getIndexHandler(req: Request, res: Response) {
  if (req.body?.challenge) {
    logger.info('get-index: webhook challenge received');
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const updateDate = new Date().toISOString().slice(0, 10);

  try {
    logger.info('get-index: fetching CBS indices');

    // CBS series 200010 (מדד מחירי תשומה בבנייה למגורים), 120010 (Consumer Price)
    const [constructionResult, consumerResult] = await Promise.all([
      getLatestConstructionIndex(),
      fetchCbsIndex(CBS_INDEX_CODES.CONSUMER_PRICE, 'Consumer Price Index'),
    ]);

    if (!constructionResult.success || !constructionResult.latest) {
      logger.warn('get-index: Construction Input fetch failed', constructionResult);
      return res.status(502).json({
        success: false,
        error: constructionResult.error ?? 'Failed to fetch Construction Input Price Index',
        details: { construction: constructionResult, consumer: consumerResult },
      });
    }

    if (!consumerResult.success || !consumerResult.latest) {
      logger.warn('get-index: Consumer Price fetch failed', consumerResult);
      return res.status(502).json({
        success: false,
        error: consumerResult.error ?? 'Failed to fetch Consumer Price Index',
        details: { construction: constructionResult, consumer: consumerResult },
      });
    }

    const [constructionItem, consumerItem] = await Promise.all([
      createIndexItem(
        INDEX_BOARD.groups.constructionInput,
        constructionResult.latest,
        updateDate
      ),
      createIndexItem(
        INDEX_BOARD.groups.consumerPrice,
        consumerResult.latest,
        updateDate
      ),
    ]);

    if (!constructionItem.success || !consumerItem.success) {
      const errors = [
        constructionItem.error && `Construction: ${constructionItem.error}`,
        consumerItem.error && `Consumer: ${consumerItem.error}`,
      ].filter(Boolean);
      return res.status(500).json({
        success: false,
        error: errors.join('; '),
        constructionItemId: constructionItem.itemId,
        consumerItemId: consumerItem.itemId,
      });
    }

    return res.status(200).json({
      success: true,
      constructionItemId: constructionItem.itemId,
      consumerItemId: consumerItem.itemId,
      constructionIndex: constructionResult.latest,
      consumerIndex: consumerResult.latest,
      updateDate,
    });
  } catch (err) {
    logger.warn('get-index error', { err });
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
}

export default router;
