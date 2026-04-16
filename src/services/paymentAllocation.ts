/**
 * Payment allocation logic: allocates actual payments across contractual payment items
 * in order: Interest → Indexation → Principal.
 *
 * דירה vs רישום זכויות: actual payment status must match contractual line status; balances are
 * tracked per category (subitems filtered by payment category). Registration lines have no
 * interest or indexation. Negative principal = discount / credit; positive receipts can absorb credit.
 *
 * Interest and indexation (apartment only) are calculated per payment from:
 * - Interest: Payment_Base_Amount × (r/365) × Late_Days + previous remaining interest
 * - Indexation: Payment_Base_Amount × (Current_Index/Base_Index - 1) + previous remaining indexation
 *   (Base_Index is always the contract base index; it does not roll forward between subitems)
 */

import { mondayQuery } from './mondayApi';
import { logger } from '../logger';
import {
  ACTUAL_PAYMENTS,
  CONTRACTUAL_PAYMENTS,
  CONTRACTS_BOARD,
  INDEX_BOARD,
} from '../config/config';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Apartment vs registration-of-rights; streams are isolated (same as separate contracts). */
export type PaymentCategory = 'דירה' | 'רישום זכויות';

export interface ActualPaymentItem {
  id: string;
  name: string;
  receiptAmount: number;
  /** Pre-VAT actual payment from source item (`numeric_mm2bfks3`); used for subitems.actualReceipt. */
  receiptAmountBeforeVat: number;
  receiptDate: string | null;
  /**
   * Optional `date_mm2bcmy6`. When set, used instead of receiptDate for index lookup,
   * interest/late-day calculation, and subitem display date (receiptDate ignored for allocation).
   */
  indexPaymentDate: string | null;
  linkedContractIds: number[];
  /** From actual payment board status; defaults to דירה when unset. */
  paymentCategory: PaymentCategory;
  /** % מע"מ from actual payment board (`numeric_mm2bnnc8`); 0 when unset. */
  vatPercent: number;
}

export interface ContractualPaymentItem {
  id: string;
  name: string;
  /** Tie-breaker when contractual due dates match (leading digits from item name). */
  paymentOrder: number;
  paymentDue: number;
  indexationPaymentDue: number;
  principal: number;
  contractualDueDate: string | null;
  /** "V" = index-linked, "X" = not index-linked (indexation always 0). Default "V" when unset. */
  indexLinkedStatus: "V" | "X";
  /** "V" = late-days/interest as usual, "X" = no late-days/interest on this item. */
  interestChargeStatus: "V" | "X";
  /** דירה | רישום זכויות — must match actual payment to allocate. */
  paymentCategory: PaymentCategory;
}

export interface RemainingBalances {
  principal: number;
  interest: number;
  indexation: number;
}

export interface AllocationResult {
  principalPaid: number;
  interestPaid: number;
  indexationPaid: number;
  remainingPrincipal: number;
  remainingInterest: number;
  remainingIndexation: number;
  amountUsed: number;
}

export interface BalancesBeforePayment {
  remainingPrincipalBefore: number;
  remainingInterestBefore: number;
  remainingIndexationBefore: number;
  /** Days used as late-day multiplier in interest (0 if within grace or no due date). */
  interestLateDays: number;
  /** (Current index / previous index − 1) × 100; 0 if not index-linked. */
  indexChangePercent: number;
  /** Index for payment date (same as Current_Index in indexation formula). */
  currentIndexValue: number;
  /** Previous index in the ratio (contract base or index at prior payment date). */
  indexationBaseIndex: number;
}

export interface SubitemPayload {
  name: string;
  columnValues: Record<string, unknown>;
}

// ─── Rounding helper ─────────────────────────────────────────────────────────

const ROUND = 2;

function round(value: number): number {
  return Math.round(value * 10 ** ROUND) / 10 ** ROUND;
}

/**
 * Gross = net × (1 + rate). Board may store VAT as a fraction (0.18) or as percent (18).
 * Matches spreadsheet-style *(1+numeric_mm2bkbnx) whether the cell is 0.18 or 18.
 */
function vatGrossMultiplier(vatRate: number): number {
  const v = Number.isFinite(vatRate) ? vatRate : 0;
  if (v === 0) return 1;
  if (Math.abs(v) < 1) return 1 + v;
  return 1 + v / 100;
}

/** Format date for subitem name: "Mar 1, 2026" */
function formatDateForDisplay(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  return `${month} ${day}, ${year}`;
}

/** Parse linked item IDs from board relation column value (handles various API formats) */
function parsePaymentCategoryLabel(cv: {
  label?: string | null;
  text?: string | null;
  value?: string | null;
}): PaymentCategory {
  const fromGraphql = (cv.label ?? cv.text ?? '').toString().trim();
  if (fromGraphql === 'רישום זכויות') return 'רישום זכויות';
  if (fromGraphql === 'דירה') return 'דירה';
  try {
    const parsed = JSON.parse(cv.value || '{}');
    const label = (parsed.label ?? parsed.text ?? '').toString().trim();
    if (label === 'רישום זכויות') return 'רישום זכויות';
    if (label === 'דירה') return 'דירה';
  } catch {
    /* ignore */
  }
  return 'דירה';
}

/** Subitem status column may omit label on legacy rows — treat as דירה only. */
function parseSubitemPaymentCategoryValue(cv: {
  label?: string | null;
  value?: string | null;
}): PaymentCategory | null {
  const fromGraphql = (cv.label ?? '').toString().trim();
  if (fromGraphql === 'רישום זכויות' || fromGraphql === 'דירה') {
    return fromGraphql === 'רישום זכויות' ? 'רישום זכויות' : 'דירה';
  }
  try {
    const parsed = JSON.parse(cv.value || '{}');
    const label = (parsed.label ?? parsed.text ?? '').toString().trim();
    if (label === 'רישום זכויות') return 'רישום זכויות';
    if (label === 'דירה') return 'דירה';
  } catch {
    /* ignore */
  }
  return null;
}

function subitemCategoryMatches(parsed: PaymentCategory | null, expected: PaymentCategory): boolean {
  if (parsed === null) return expected === 'דירה';
  return parsed === expected;
}

function parseBoardRelationIds(value: string | null | undefined): number[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    const ids = parsed.linkedPulseIds ?? parsed.item_ids ?? parsed.linked_item_ids ?? [];
    return (Array.isArray(ids) ? ids : [])
      .map((x: { linkedPulseId?: number | string } | number | string) => {
        if (typeof x === 'number') return x;
        if (typeof x === 'string') return parseInt(x, 10);
        return typeof x.linkedPulseId === 'number' ? x.linkedPulseId : parseInt(String(x.linkedPulseId ?? ''), 10);
      })
      .filter((id): id is number => !isNaN(id));
  } catch {
    return [];
  }
}

// ─── Fetch actual payment item ──────────────────────────────────────────────

export async function fetchActualPaymentItem(
  itemId: string
): Promise<ActualPaymentItem | null> {
  const query = `
    query GetActualPayment($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        column_values(ids: ["${ACTUAL_PAYMENTS.columns.receiptAmount}", "${ACTUAL_PAYMENTS.columns.receiptAmountBeforeVat}", "${ACTUAL_PAYMENTS.columns.receiptDate}", "${ACTUAL_PAYMENTS.columns.indexPaymentDate}", "${ACTUAL_PAYMENTS.columns.contracts}", "${ACTUAL_PAYMENTS.columns.contractId}", "${ACTUAL_PAYMENTS.columns.paymentCategory}", "${ACTUAL_PAYMENTS.columns.vatPercent}"]) {
          id
          value
          type
          ... on BoardRelationValue {
            linked_item_ids
          }
          ... on StatusValue {
            label
          }
        }
      }
    }
  `;

  type ColumnValue = {
    id: string;
    value?: string | null;
    type: string;
    linked_item_ids?: string[];
    label?: string | null;
  };
  const data = await mondayQuery<{ items: Array<{ id: string; name: string; column_values: ColumnValue[] }> }>(query, { itemId: parseInt(itemId, 10) });

  const item = data.items?.[0];
  if (!item) {
    logger.warn('Actual payment item not found', { itemId });
    return null;
  }

  let receiptAmount = 0;
  let receiptAmountBeforeVat = 0;
  let receiptDate: string | null = null;
  let indexPaymentDate: string | null = null;
  let linkedContractIds: number[] = [];
  let contractIdText: string | null = null;
  let paymentCategory: PaymentCategory = 'דירה';
  let vatPercent = 0;

  for (const cv of item.column_values) {
    if (cv.id === ACTUAL_PAYMENTS.columns.receiptAmount) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        receiptAmount = parseFloat(parsed.value ?? parsed) || 0;
      } catch {
        receiptAmount = parseFloat(cv.value ?? '') || 0;
      }
    } else if (cv.id === ACTUAL_PAYMENTS.columns.receiptAmountBeforeVat) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        receiptAmountBeforeVat = parseFloat(parsed.value ?? parsed) || 0;
      } catch {
        receiptAmountBeforeVat = parseFloat(cv.value ?? '') || 0;
      }
    } else if (cv.id === ACTUAL_PAYMENTS.columns.receiptDate) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        receiptDate = parsed.date ?? null;
      } catch {
        receiptDate = cv.value || null;
      }
    } else if (cv.id === ACTUAL_PAYMENTS.columns.indexPaymentDate) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        indexPaymentDate = parsed.date ? String(parsed.date).slice(0, 10) : null;
      } catch {
        indexPaymentDate = typeof cv.value === 'string' && cv.value.trim() ? cv.value.slice(0, 10) : null;
      }
    } else if (cv.id === ACTUAL_PAYMENTS.columns.contracts) {
      // API 2025-04+ returns value: null for board_relation; use linked_item_ids instead
      const ids = (cv as ColumnValue).linked_item_ids;
      if (ids?.length) {
        linkedContractIds = ids.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));
      } else {
        linkedContractIds = parseBoardRelationIds(cv.value ?? null);
      }
    } else if (cv.id === ACTUAL_PAYMENTS.columns.contractId) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        contractIdText = parsed.text ?? parsed.value ?? (typeof cv.value === 'string' ? cv.value : null);
      } catch {
        contractIdText = typeof cv.value === 'string' ? cv.value : null;
      }
      if (contractIdText && typeof contractIdText !== 'string') contractIdText = String(contractIdText);
    } else if (cv.id === ACTUAL_PAYMENTS.columns.paymentCategory) {
      paymentCategory = parsePaymentCategoryLabel(cv);
    } else if (cv.id === ACTUAL_PAYMENTS.columns.vatPercent) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        vatPercent = parseFloat(parsed.value ?? parsed) || 0;
      } catch {
        vatPercent = parseFloat(cv.value ?? '') || 0;
      }
    }
  }

  // Fallback: if board relation is empty but contractId text column has a value, use it
  if (linkedContractIds.length === 0 && contractIdText?.trim()) {
    const parsed = parseInt(contractIdText.trim(), 10);
    if (!isNaN(parsed)) linkedContractIds = [parsed];
  }

  if (!receiptAmount || receiptAmount <= 0) {
    logger.warn('Actual payment item has no valid receipt amount', { itemId, receiptAmount });
  }

  return {
    id: item.id,
    name: item.name ?? '',
    receiptAmount: round(receiptAmount),
    receiptAmountBeforeVat: round(receiptAmountBeforeVat || receiptAmount),
    receiptDate,
    indexPaymentDate,
    linkedContractIds,
    paymentCategory,
    vatPercent: round(vatPercent),
  };
}

// ─── Extract contract ID ────────────────────────────────────────────────────

export function extractContractId(actualPayment: ActualPaymentItem): number | null {
  const id = actualPayment.linkedContractIds?.[0] ?? null;
  if (!id) {
    logger.warn('No linked contract on actual payment item', { itemId: actualPayment.id });
  }
  return id;
}

// ─── Find matching contractual payment items ─────────────────────────────────
// Note: Board relation columns are not supported in items_page_by_column_values,
// so we fetch items and filter by contract link in code.

export async function findMatchingContractualItems(
  contractId: number,
  paymentCategory: PaymentCategory
): Promise<ContractualPaymentItem[]> {
  type ContractualColumnValue = { id: string; value?: string | null; text?: string | null; label?: string | null; linked_item_ids?: string[] };
  const allItems: Array<{ id: string; name: string; column_values: ContractualColumnValue[] }> = [];
  let cursor: string | null = null;

  const columnIds = [
    CONTRACTUAL_PAYMENTS.items.contractLink,
    CONTRACTUAL_PAYMENTS.items.paymentDue,
    CONTRACTUAL_PAYMENTS.items.principalDue,
    CONTRACTUAL_PAYMENTS.items.indexationPaymentDue,
    CONTRACTUAL_PAYMENTS.items.contractualDueDate,
    CONTRACTUAL_PAYMENTS.items.indexLinkedStatus,
    CONTRACTUAL_PAYMENTS.items.interestChargeStatus,
    CONTRACTUAL_PAYMENTS.items.paymentCategory,
    CONTRACTUAL_PAYMENTS.items.principalBeforeVat,
  ].join('", "');

  do {
    const query: string = cursor
      ? `
        query GetContractualItemsNext($cursor: String!) {
          next_items_page(cursor: $cursor, limit: 500) {
            cursor
            items {
                id
                name
                column_values(ids: ["${columnIds}"]) {
                id
                value
                text
                ... on BoardRelationValue {
                  linked_item_ids
                }
                ... on StatusValue {
                  label
                }
              }
            }
          }
        }
      `
      : `
        query GetContractualItems($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 500) {
              cursor
            items {
                id
                name
                column_values(ids: ["${columnIds}"]) {
                id
                value
                text
                ... on BoardRelationValue {
                  linked_item_ids
                }
                ... on StatusValue {
                  label
                }
              }
            }
            }
          }
        }
      `;

    type PageResult = { cursor: string | null; items: typeof allItems };
    let page: PageResult | undefined;
    if (cursor) {
      const data: { next_items_page: PageResult } = await mondayQuery(query, { cursor });
      page = data.next_items_page;
    } else {
      const data: { boards: Array<{ items_page: PageResult }> } = await mondayQuery(query, { boardId: CONTRACTUAL_PAYMENTS.boardId });
      page = data.boards?.[0]?.items_page;
    }
    cursor = page?.cursor ?? null;
    allItems.push(...(page?.items ?? []));
  } while (cursor);

  const items = allItems.filter((item) => {
    const cv = item.column_values.find((c) => c.id === CONTRACTUAL_PAYMENTS.items.contractLink);
    if (!cv) return false;
    // API 2025-04+ returns value: null for board_relation; use linked_item_ids instead
    const ids = cv.linked_item_ids;
    if (ids?.length) {
      const linked = ids.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));
      return linked.includes(contractId);
    }
    if (!cv.value) return false;
    try {
      const parsed = JSON.parse(cv.value);
      const parsedIds = parsed.linkedPulseIds ?? parsed.item_ids ?? [];
      const linked = Array.isArray(parsedIds)
        ? parsedIds.map((x: { linkedPulseId?: number } | number) =>
            typeof x === 'number' ? x : x.linkedPulseId
          ).filter((id): id is number => typeof id === 'number')
        : [];
      return linked.includes(contractId);
    } catch {
      return false;
    }
  });

  if (items.length === 0) {
    logger.warn('No contractual payment items found for contract', { contractId });
    return [];
  }

  /** Parse payment order from item name — used as tie-breaker when due dates match. */
  function parsePaymentOrder(name: string): number {
    const match = name?.trim().match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 999;
  }

  /** Earliest due date first (`date_mm0t3zcj`); missing/invalid dates last. */
  function sortKeyDueDate(iso: string | null): number {
    if (!iso?.trim()) return Number.POSITIVE_INFINITY;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  }

  const contractual: ContractualPaymentItem[] = items.map((item) => {
    let paymentDue = 0;
    let principalDue = 0;
    let principalBeforeVat = 0;
    let indexationPaymentDue = 0;
    let contractualDueDate: string | null = null;
    let indexLinkedStatus: "V" | "X" = "V";
    let interestChargeStatus: "V" | "X" = "V";
    let rowPaymentCategory: PaymentCategory = 'דירה';

    for (const cv of item.column_values) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        if (cv.id === CONTRACTUAL_PAYMENTS.items.contractualDueDate) {
          contractualDueDate = parsed.date ?? null;
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.paymentCategory) {
          rowPaymentCategory = parsePaymentCategoryLabel(cv as ContractualColumnValue);
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexLinkedStatus) {
          const labelRaw = (cv as ContractualColumnValue).label ?? (cv as ContractualColumnValue).text ?? parsed.label ?? parsed.additional_info?.label;
          const label = (labelRaw ?? "").toString().trim().toUpperCase();
          indexLinkedStatus = label === "X" ? "X" : "V";
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.interestChargeStatus) {
          const labelRaw = (cv as ContractualColumnValue).label ?? (cv as ContractualColumnValue).text ?? parsed.label ?? parsed.additional_info?.label;
          const label = (labelRaw ?? "").toString().trim().toUpperCase();
          interestChargeStatus = label === "X" ? "X" : "V";
        } else {
          const val = parseFloat(parsed.value ?? parsed) || 0;
          if (cv.id === CONTRACTUAL_PAYMENTS.items.paymentDue) paymentDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.principalDue) principalDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.principalBeforeVat) principalBeforeVat = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexationPaymentDue) indexationPaymentDue = val;
        }
      } catch {
        if (cv.id === CONTRACTUAL_PAYMENTS.items.contractualDueDate) {
          contractualDueDate = cv.value ?? null;
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.paymentCategory) {
          rowPaymentCategory = parsePaymentCategoryLabel(cv as ContractualColumnValue);
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexLinkedStatus) {
          const labelRaw = (cv as ContractualColumnValue).label ?? (cv as ContractualColumnValue).text ?? cv.value;
          const label = (labelRaw ?? "").toString().trim().toUpperCase();
          indexLinkedStatus = label === "X" ? "X" : "V";
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.interestChargeStatus) {
          const labelRaw = (cv as ContractualColumnValue).label ?? (cv as ContractualColumnValue).text ?? cv.value;
          const label = (labelRaw ?? "").toString().trim().toUpperCase();
          interestChargeStatus = label === "X" ? "X" : "V";
        } else {
          const val = parseFloat(cv.value ?? '') || 0;
          if (cv.id === CONTRACTUAL_PAYMENTS.items.paymentDue) paymentDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.principalDue) principalDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.principalBeforeVat) principalBeforeVat = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexationPaymentDue) indexationPaymentDue = val;
        }
      }
    }

    // Principal for first subitem — allow negative (discount / credit). Prefer קרן לפני מע"מ when non-zero; else legacy columns.
    const principal = round(
      principalBeforeVat !== 0 ? principalBeforeVat : principalDue || paymentDue
    );
    const paymentOrder = parsePaymentOrder(item.name ?? '');

    return {
      id: item.id,
      name: item.name ?? '',
      paymentOrder,
      paymentDue,
      indexationPaymentDue,
      principal,
      contractualDueDate,
      indexLinkedStatus,
      interestChargeStatus,
      paymentCategory: rowPaymentCategory,
    };
  });

  const filtered = contractual.filter((c) => c.paymentCategory === paymentCategory);

  filtered.sort((a, b) => {
    const da = sortKeyDueDate(a.contractualDueDate);
    const db = sortKeyDueDate(b.contractualDueDate);
    if (da !== db) return da - db;
    return a.paymentOrder - b.paymentOrder;
  });

  return filtered;
}

// ─── Index period for payment date ───────────────────────────────────────────
/**
 * Index is published every month on the 15th for the previous month.
 * - If payment date is before the 15th: use index of two months earlier.
 * - If payment date is on or after the 15th: use index of previous month.
 * Returns period as "MM-YYYY" to match Indices board item names.
 * (Exact period may be missing on the board — see fetchIndexForPaymentDate fallback.)
 */
function getIndexPeriodForPaymentDate(paymentDate: string): string {
  const d = new Date(paymentDate);
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();

  let targetMonth: number;
  let targetYear: number;

  if (day < 15) {
    targetMonth = month - 2;
    targetYear = year;
  } else {
    targetMonth = month - 1;
    targetYear = year;
  }

  while (targetMonth < 1) {
    targetMonth += 12;
    targetYear--;
  }

  return `${String(targetMonth).padStart(2, '0')}-${targetYear}`;
}

/** Convert "MM-YYYY" to "YYYY-MM" for chronological comparison */
function getPeriodSortKey(period: string): string {
  const [mm, yyyy] = period.split('-');
  return `${yyyy}-${mm}`;
}

// ─── Fetch index from Monday Indices board for payment date ──────────────────
/**
 * Used for both Current_Index and Previous_Index (when from previous subitem).
 * Item name format: "01-2026" (MM-YYYY).
 *
 * Target period: previous month, or 2 months earlier if payment before 15th (index published on 15th).
 * If that month is not on the board yet (e.g. April 15 → target March, March row missing), uses the
 * most recent published period at or before the target (e.g. February).
 */
export async function fetchIndexForPaymentDate(
  paymentDate: string
): Promise<{ value: number; period: string } | null> {
  const targetPeriod = getIndexPeriodForPaymentDate(paymentDate);
  const col = INDEX_BOARD.columns.indexValue;
  const allItems: Array<{ name: string; column_values: Array<{ id: string; value: string }> }> = [];
  let cursor: string | null = null;

  type Page = { cursor: string | null; items: typeof allItems };

  do {
    const queryStr: string = cursor
      ? `
        query GetIndexItemsNext($cursor: String!) {
          next_items_page(cursor: $cursor, limit: 500) {
            cursor
            items { name column_values(ids: ["${col}"]) { id value } }
          }
        }
      `
      : `
        query GetIndexItems($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 500) {
              cursor
              items { name column_values(ids: ["${col}"]) { id value } }
            }
          }
        }
      `;

    let page: Page | undefined;
    if (cursor) {
      const res: { next_items_page: Page } = await mondayQuery(queryStr, { cursor });
      page = res.next_items_page;
    } else {
      const res: { boards: Array<{ items_page: Page }> } = await mondayQuery(queryStr, { boardId: INDEX_BOARD.boardId });
      page = res.boards?.[0]?.items_page;
    }
    cursor = page?.cursor ?? null;
    allItems.push(...(page?.items ?? []));
  } while (cursor);

  const withPeriod = allItems
    .map((item) => {
      const m = item.name?.trim().match(/^(\d{1,2})-(\d{4})$/);
      if (!m) return null;
      const [, mm, yyyy] = m;
      const period = `${mm!.padStart(2, '0')}-${yyyy}`;
      const cv = item.column_values.find((c) => c.id === col);
      let value = 0;
      if (cv?.value) {
        try {
          const parsed = JSON.parse(cv.value);
          value = parseFloat(parsed.value ?? parsed) || 0;
        } catch {
          value = parseFloat(cv.value) || 0;
        }
      }
      return { period, value };
    })
    .filter((x): x is NonNullable<typeof x> => x != null && x.value > 0);

  let match = withPeriod.find((x) => x.period === targetPeriod);

  if (!match) {
    // Target period not yet published - use most recent available index <= target (go back month by month)
    const targetKey = getPeriodSortKey(targetPeriod);
    const availableForTarget = withPeriod
      .filter((x) => getPeriodSortKey(x.period) <= targetKey)
      .sort((a, b) => getPeriodSortKey(b.period).localeCompare(getPeriodSortKey(a.period)));
    match = availableForTarget[0];
  }

  if (!match) {
    logger.warn('No index found for payment date', { paymentDate, targetPeriod, availablePeriods: withPeriod.map((x) => x.period) });
    return null;
  }

  return { value: match.value, period: match.period };
}

// ─── Fetch contract details (interest rate, base index) ──────────────────────

export interface ContractDetails {
  interestRatePercent: number;
  baseIndex: number;
  /** Date used for base index (from contract). Null when using numeric column. */
  baseIndexDate: string | null;
  /** Index period (MM-YYYY) from Indices board. Null when using numeric column. */
  baseIndexPeriod: string | null;
}

export async function fetchContractDetails(contractId: number): Promise<ContractDetails | null> {
  const irCol = CONTRACTS_BOARD.columns.interestRatePercent;
  const biCol = CONTRACTS_BOARD.columns.baseIndex;
  const bidCol = CONTRACTS_BOARD.columns.baseIndexDate;

  const query = `
    query GetContract($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        column_values(ids: ["${irCol}", "${biCol}", "${bidCol}"]) {
          id
          value
        }
      }
    }
  `;

  const data = await mondayQuery<{ items: Array<{ column_values: Array<{ id: string; value: string }> }> }>(query, {
    itemId: contractId,
  });

  const item = data.items?.[0];
  if (!item) {
    logger.warn('Contract not found', { contractId });
    return null;
  }

  let interestRatePercent = 0;
  let baseIndex = 100;
  let baseIndexDateIso: string | null = null;

  for (const cv of item.column_values) {
    try {
      const parsed = JSON.parse(cv.value || '{}');
      if (cv.id === irCol) {
        const val = parseFloat(parsed.value ?? parsed) || 0;
        interestRatePercent = val;
      } else if (cv.id === biCol) {
        const val = parseFloat(parsed.value ?? parsed) || 0;
        baseIndex = val > 0 ? val : 100;
      } else if (cv.id === bidCol && parsed.date) {
        baseIndexDateIso = String(parsed.date).slice(0, 10);
      }
    } catch {
      if (cv.id === irCol) {
        const val = parseFloat(cv.value ?? '') || 0;
        interestRatePercent = val;
      } else if (cv.id === biCol) {
        const val = parseFloat(cv.value ?? '') || 0;
        baseIndex = val > 0 ? val : 100;
      }
    }
  }

  let baseIndexPeriod: string | null = null;
  if (baseIndexDateIso) {
    const indexResult = await fetchIndexForPaymentDate(baseIndexDateIso);
    if (indexResult) {
      baseIndex = indexResult.value;
      baseIndexPeriod = indexResult.period;
    } else {
      logger.warn('Could not fetch base index from Indices board for date, using fallback', {
        contractId,
        baseIndexDate: baseIndexDateIso,
        fallbackBaseIndex: baseIndex,
      });
    }
  }

  return { interestRatePercent, baseIndex, baseIndexDate: baseIndexDateIso, baseIndexPeriod };
}

// ─── Get previous subitem (the one before the next we create) ────────────────

interface PreviousSubitemBalances {
  remainingPrincipal: number;
  remainingInterest: number;
  remainingIndexation: number;
  /** Payment date of previous subitem (name), for index lookup. Null if first subitem. */
  previousSubitemPaymentDate: string | null;
}

export async function getPreviousSubitemBalances(
  parentItemId: string,
  parentOriginalPrincipal: number,
  paymentCategory: PaymentCategory
): Promise<PreviousSubitemBalances> {
  const sub = CONTRACTUAL_PAYMENTS.subitems;
  const query = `
    query GetSubitems($parentId: ID!) {
      items(ids: [$parentId]) {
        subitems {
          name
          column_values(ids: ["${sub.remainingPrincipal}", "${sub.remainingInterest}", "${sub.remainingIndexLinkage}", "${sub.paymentCategory}"]) {
            id
            value
            ... on StatusValue {
              label
            }
          }
          created_at
        }
      }
    }
  `;

  const data = await mondayQuery<{
    items: Array<{
      subitems: Array<{
        name: string;
        column_values: Array<{ id: string; value: string; label?: string | null }>;
        created_at: string;
      }>;
    }>;
  }>(query, { parentId: parentItemId });

  const rawSubitems = data.items?.[0]?.subitems ?? [];

  const matching = rawSubitems.filter((s) => {
    const catCv = s.column_values.find((c) => c.id === sub.paymentCategory);
    const parsed = catCv ? parseSubitemPaymentCategoryValue(catCv) : null;
    return subitemCategoryMatches(parsed, paymentCategory);
  });

  if (matching.length === 0) {
    return {
      remainingPrincipal: parentOriginalPrincipal,
      remainingInterest: 0,
      remainingIndexation: 0,
      previousSubitemPaymentDate: null,
    };
  }

  const latest = matching.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];

  let remainingPrincipal = parentOriginalPrincipal;
  let remainingInterest = 0;
  let remainingIndexation = 0;

  for (const cv of latest.column_values) {
    try {
      const parsed = JSON.parse(cv.value || '{}');
      const val = round(parseFloat(parsed.value ?? parsed) || 0);
      if (cv.id === sub.remainingPrincipal) remainingPrincipal = val;
      else if (cv.id === sub.remainingInterest) remainingInterest = val;
      else if (cv.id === sub.remainingIndexLinkage) remainingIndexation = val;
    } catch {
      const val = round(parseFloat(cv.value) || 0);
      if (cv.id === sub.remainingPrincipal) remainingPrincipal = val;
      else if (cv.id === sub.remainingInterest) remainingInterest = val;
      else if (cv.id === sub.remainingIndexLinkage) remainingIndexation = val;
    }
  }

  const previousSubitemPaymentDate = latest.name?.trim() || null;

  return {
    remainingPrincipal,
    remainingInterest,
    remainingIndexation,
    previousSubitemPaymentDate,
  };
}

/** Convert subitem name (e.g. "Mar 15, 2026") to ISO date for API calls */
function parseSubitemNameToIsoDate(name: string | null): string | null {
  if (!name?.trim()) return null;
  const d = new Date(name);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ─── Compute interest (7-day grace) ───────────────────────────────────────────
const GRACE_DAYS = 7;

/** Calendar days from due date used in the interest formula (after grace); never negative. */
function computeInterestLateDays(
  interestBaseAmount: number,
  contractualDueDate: string | null,
  paymentDate: string
): number {
  if (!contractualDueDate || interestBaseAmount <= 0) return 0;

  const due = new Date(contractualDueDate);
  const paid = new Date(paymentDate);
  const diffMs = paid.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= GRACE_DAYS) return 0;

  return diffDays;
}

function computeLateInterest(
  interestBaseAmount: number,
  interestRatePercent: number,
  contractualDueDate: string | null,
  paymentDate: string,
  lateDaysOverride?: number
): number {
  if (interestBaseAmount <= 0) return 0;

  const diffDays =
    lateDaysOverride !== undefined
      ? lateDaysOverride
      : computeInterestLateDays(interestBaseAmount, contractualDueDate, paymentDate);
  if (diffDays <= 0) return 0;

  const r = interestRatePercent / 100;
  const interest = interestBaseAmount * (r / 365) * diffDays;
  const result = round(interest);

  logger.info('Interest', {
    formula: 'Payment_Base_Amount × (r / 365) × Late_Days',
    calculation: `${interestBaseAmount} × (${r} / 365) × ${diffDays} = ${result}`,
  });

  return result;
}

// ─── Compute indexation balance ──────────────────────────────────────────────

function computeIndexationBalance(
  indexationBaseAmount: number,
  currentIndex: number,
  previousIndex: number
): number {
  if (indexationBaseAmount <= 0 || previousIndex <= 0) return 0;

  const ratio = currentIndex / previousIndex;
  const indexation = indexationBaseAmount * (ratio - 1);
  let result = round(indexation);

  if (result < 0) result = 0;

  logger.info('Indexation', {
    ratio: `${currentIndex} / ${previousIndex} = ${ratio.toFixed(4)}`,
    calculation: `${indexationBaseAmount} × (${ratio.toFixed(4)} - 1) = ${indexationBaseAmount} × ${(ratio - 1).toFixed(4)} = ${result}`,
  });

  return result;
}

// ─── Compute balances before payment ─────────────────────────────────────────

export async function computeBalancesBeforePayment(
  parentItemId: string,
  contractualItem: ContractualPaymentItem,
  /** Effective date for index / subitem name (may use index override column on actual payment). */
  paymentDate: string,
  /** Actual receipt date (`date_mm0tny6b`) for late-days vs contractual due — not the index override. */
  receiptDateForLateDays: string,
  /** Amount available to allocate to this contractual item (pre-VAT). Used as base for interest+indexation. */
  actualPaymentAmountForThisItem: number,
  contractDetails: ContractDetails | null,
  currentIndex: number,
  currentIndexPeriod: string
): Promise<{ balances: BalancesBeforePayment; remaining: RemainingBalances }> {
  const previous = await getPreviousSubitemBalances(
    parentItemId,
    contractualItem.principal,
    contractualItem.paymentCategory
  );

  const remainingPrincipalBefore = previous.remainingPrincipal;

  /** רישום זכויות: no interest, no indexation; separate balance stream from apartment. */
  if (contractualItem.paymentCategory === 'רישום זכויות') {
    const balances: BalancesBeforePayment = {
      remainingPrincipalBefore,
      remainingInterestBefore: 0,
      remainingIndexationBefore: 0,
      interestLateDays: 0,
      indexChangePercent: 0,
      currentIndexValue: 0,
      indexationBaseIndex: 0,
    };
    const remaining: RemainingBalances = {
      principal: remainingPrincipalBefore,
      interest: 0,
      indexation: 0,
    };
    return { balances, remaining };
  }

  const interestRatePercent = contractDetails?.interestRatePercent ?? 0;
  const contractBaseIndex = contractDetails?.baseIndex ?? 100;

  const previousIndex = contractBaseIndex;
  const baseIndexPeriod: string | null = contractDetails?.baseIndexPeriod ?? null;

  const paymentBaseAmount = round(
    Math.min(
      Math.max(actualPaymentAmountForThisItem, 0),
      Math.max(remainingPrincipalBefore, 0)
    )
  );

  const dueForLateDays = contractualItem.contractualDueDate;

  const interestLateDays = contractualItem.interestChargeStatus === "X"
    ? 0
    : computeInterestLateDays(
      paymentBaseAmount,
      dueForLateDays,
      receiptDateForLateDays
    );

  const calculatedInterest = contractualItem.interestChargeStatus === "X"
    ? 0
    : computeLateInterest(
      paymentBaseAmount,
      interestRatePercent,
      dueForLateDays,
      receiptDateForLateDays,
      interestLateDays
    );
  const remainingInterestBefore = round(calculatedInterest + previous.remainingInterest);

  let calculatedIndexation = 0;
  let remainingIndexationBefore = 0;
  let indexChangePercent = 0;

  const baseIndexDate = previous.previousSubitemPaymentDate
    ? previous.previousSubitemPaymentDate
    : contractDetails?.baseIndexDate ?? 'numeric column';

  if (contractualItem.indexLinkedStatus !== "X") {
    logger.info('Payment', {
      paymentDate,
      currentIndexPeriod,
      baseIndexDate,
      baseIndexPeriod: baseIndexPeriod ?? 'numeric column',
    });
  }

  if (contractualItem.indexLinkedStatus === "X") {
    // indexation skipped
  } else {
    calculatedIndexation = computeIndexationBalance(
      paymentBaseAmount,
      currentIndex,
      previousIndex
    );
    remainingIndexationBefore = round(calculatedIndexation + previous.remainingIndexation);
    if (previousIndex > 0) {
      indexChangePercent = round((currentIndex / previousIndex - 1) * 100);
    }
  }

  const balances: BalancesBeforePayment = {
    remainingPrincipalBefore,
    remainingInterestBefore,
    remainingIndexationBefore,
    interestLateDays,
    indexChangePercent,
    currentIndexValue: currentIndex,
    indexationBaseIndex: previousIndex,
  };

  const remaining: RemainingBalances = {
    principal: remainingPrincipalBefore,
    interest: remainingInterestBefore,
    indexation: remainingIndexationBefore,
  };

  return { balances, remaining };
}

// ─── Allocate payment amount by priority (interest → indexation → principal) ─

export function allocatePayment(
  amount: number,
  initialBalances: RemainingBalances
): AllocationResult {
  let remaining = round(amount);
  const { interest, indexation } = initialBalances;
  const principal = initialBalances.principal;

  let interestPaid = 0;
  if (interest > 0) {
    interestPaid = round(Math.min(remaining, interest));
    remaining = round(remaining - interestPaid);
  }

  let indexationPaid = 0;
  if (indexation > 0) {
    indexationPaid = round(Math.min(remaining, indexation));
    remaining = round(remaining - indexationPaid);
  }

  let principalPaid = 0;
  if (principal > 0) {
    principalPaid = round(Math.min(remaining, principal));
    remaining = round(remaining - principalPaid);
  } else if (principal < 0) {
    const credit = -principal;
    const absorb = round(Math.min(remaining, credit));
    principalPaid = absorb;
    remaining = round(remaining - absorb);
  }

  const remainingPrincipal =
    principal > 0
      ? round(principal - principalPaid)
      : principal < 0
        ? round(principal + principalPaid)
        : round(principal);
  const remainingInterest = round(interest - interestPaid);
  const remainingIndexation = round(indexation - indexationPaid);

  const amountUsed = round(interestPaid + indexationPaid + principalPaid);

  return {
    principalPaid,
    interestPaid,
    indexationPaid,
    remainingPrincipal,
    remainingInterest,
    remainingIndexation,
    amountUsed,
  };
}

// ─── Create subitem payload ──────────────────────────────────────────────────

export function createSubitemPayload(
  paymentDate: string,
  allocation: AllocationResult,
  balancesBefore: BalancesBeforePayment,
  actualPaymentName: string,
  actualPaymentItemId: string,
  /** Same as actual payment board receipt (numeric_mm0tyhpc); repeated on each subitem when split */
  originalActualReceiptTotal: number,
  isPartOfSplitPayment: boolean,
  paymentCategory: PaymentCategory,
  /** % מע"מ from actual payment — copied to subitem and used for יתרת תשלום אחרי מע"מ */
  vatPercent: number
): SubitemPayload {
  const sub = CONTRACTUAL_PAYMENTS.subitems;
  /** Pre-VAT amounts actually allocated in this subitem (same as mm1bkqds + mm19panw + mm1srrt5). */
  const paidThisLinePreVat =
    allocation.interestPaid + allocation.indexationPaid + allocation.principalPaid;
  const remainingPaymentAfterVat = round(paidThisLinePreVat * vatGrossMultiplier(vatPercent));
  const splitPaymentAfterVat = round(paidThisLinePreVat * vatGrossMultiplier(vatPercent));
  // Monday API: numerics/text as plain strings; status/color needs a JSON object in the outer column_values (same pattern as date columns in indexBoard).
  const columnValues: Record<string, unknown> = {
    [sub.actualPaymentName]: actualPaymentName || '',
    [sub.actualPaymentItemId]: actualPaymentItemId || '',
    [sub.paymentCategory]: { label: paymentCategory },
    [sub.originalActualReceiptTotal]: String(round(originalActualReceiptTotal)),
    [sub.actualReceipt]: String(round(paidThisLinePreVat)),
    [sub.splitPaymentAfterVat]: String(splitPaymentAfterVat),
    [sub.remainingPrincipalBeforePayment]: String(balancesBefore.remainingPrincipalBefore),
    [sub.remainingInterestBeforePayment]: String(balancesBefore.remainingInterestBefore),
    [sub.remainingIndexationBeforePayment]: String(balancesBefore.remainingIndexationBefore),
    [sub.interest]: String(allocation.interestPaid),
    [sub.indexLinkage]: String(allocation.indexationPaid),
    [sub.principalPayment]: String(allocation.principalPaid),
    [sub.interestLateDays]: String(balancesBefore.interestLateDays),
    [sub.indexChangePercent]: String(balancesBefore.indexChangePercent),
    [sub.currentIndexValue]: String(round(balancesBefore.currentIndexValue)),
    [sub.indexationBaseIndex]: String(round(balancesBefore.indexationBaseIndex)),
    [sub.remainingInterest]: String(allocation.remainingInterest),
    [sub.remainingIndexLinkage]: String(allocation.remainingIndexation),
    [sub.remainingPrincipal]: String(allocation.remainingPrincipal),
    [sub.vatPercent]: String(round(vatPercent)),
    [sub.remainingPaymentAfterVat]: String(remainingPaymentAfterVat),
  };
  if (isPartOfSplitPayment) {
    // Status index 1 = "כן" on this column; must be an object, not a stringified blob (create_subitem stringifies column_values once).
    columnValues[sub.splitPaymentIndicator] = { index: 1 };
  }
  return {
    name: formatDateForDisplay(paymentDate),
    columnValues,
  };
}

// ─── Create subitem via API ──────────────────────────────────────────────────

export async function createSubitem(
  parentItemId: string,
  payload: SubitemPayload
): Promise<string> {
  const columnValuesJson = JSON.stringify(payload.columnValues);

  const mutation = `
    mutation CreateSubitem($parentId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_subitem(
        parent_item_id: $parentId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  const data = await mondayQuery<{ create_subitem: { id: string } }>(mutation, {
    parentId: parseInt(parentItemId, 10),
    itemName: payload.name,
    columnValues: columnValuesJson,
  });

  const id = data.create_subitem?.id;
  if (!id) {
    throw new Error('Failed to create subitem: no ID returned');
  }

  return id;
}

// ─── Main orchestration: apply payment from webhook ──────────────────────────

export interface ApplyPaymentInput {
  actualPaymentItemId: string;
}

export interface ApplyPaymentResult {
  success: boolean;
  subitemsCreated: number;
  error?: string;
}

export async function applyPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult> {
  const { actualPaymentItemId } = input;
  const actualPayment = await fetchActualPaymentItem(actualPaymentItemId);
  if (!actualPayment) {
    return { success: false, subitemsCreated: 0, error: 'Actual payment item not found' };
  }

  if (!actualPayment.receiptAmountBeforeVat || actualPayment.receiptAmountBeforeVat <= 0) {
    return { success: false, subitemsCreated: 0, error: 'Invalid or missing pre-VAT receipt amount' };
  }

  const contractId = extractContractId(actualPayment);
  if (contractId === null) {
    return { success: false, subitemsCreated: 0, error: 'No linked contract on actual payment item' };
  }

  const contractualItems = await findMatchingContractualItems(contractId, actualPayment.paymentCategory);
  if (contractualItems.length === 0) {
    return { success: false, subitemsCreated: 0, error: 'No matching contractual payment items found' };
  }

  /** Effective date for index and subitem name: optional index override, else receipt date. */
  const paymentDate =
    actualPayment.indexPaymentDate?.trim() ||
    actualPayment.receiptDate ||
    new Date().toISOString().slice(0, 10);

  /** Late days: always contractual `date_mm0t3zcj` vs actual `date_mm0tny6b` only (not index override). */
  const receiptDateForLateDays =
    actualPayment.receiptDate?.trim() ||
    paymentDate;

  const isRegistrationPayment = actualPayment.paymentCategory === 'רישום זכויות';

  const [contractDetails, indexResult] = await Promise.all([
    isRegistrationPayment ? Promise.resolve(null) : fetchContractDetails(contractId),
    isRegistrationPayment ? Promise.resolve(null) : fetchIndexForPaymentDate(paymentDate),
  ]);

  const currentIndex = indexResult?.value ?? 100;
  if (!isRegistrationPayment && !indexResult) {
    logger.warn('No index from Monday board, using 100 for indexation');
  }

  let remainingToAllocate = round(actualPayment.receiptAmountBeforeVat);

  type PendingSubitem = {
    parentItemId: string;
    contractualItem: ContractualPaymentItem;
    allocation: AllocationResult;
    balances: BalancesBeforePayment;
  };
  const pending: PendingSubitem[] = [];

  for (const item of contractualItems) {
    if (remainingToAllocate <= 0) break;

    const { balances, remaining } = await computeBalancesBeforePayment(
      item.id,
      item,
      paymentDate,
      receiptDateForLateDays,
      remainingToAllocate,
      contractDetails,
      currentIndex,
      indexResult?.period ?? 'N/A'
    );

    const totalRemaining = round(remaining.principal + remaining.interest + remaining.indexation);

    if (totalRemaining === 0) continue;
    if (totalRemaining < 0 && remainingToAllocate <= 0) continue;

    const allocation = allocatePayment(remainingToAllocate, remaining);
    if (allocation.amountUsed <= 0) break;

    pending.push({
      parentItemId: item.id,
      contractualItem: item,
      allocation,
      balances,
    });

    remainingToAllocate = round(remainingToAllocate - allocation.amountUsed);
  }

  const paymentSplitAcrossMultiple = pending.length > 1;
  let subitemsCreated = 0;

  for (const p of pending) {
    const payload = createSubitemPayload(
      paymentDate,
      p.allocation,
      p.balances,
      actualPayment.name,
      actualPayment.id,
      actualPayment.receiptAmount,
      paymentSplitAcrossMultiple,
      actualPayment.paymentCategory,
      actualPayment.vatPercent
    );

    await createSubitem(p.parentItemId, payload);
    subitemsCreated++;

    if (
      (p.contractualItem.paymentCategory === 'רישום זכויות' ||
        p.contractualItem.indexLinkedStatus === 'X') &&
      p.allocation.interestPaid === 0 &&
      p.allocation.indexationPaid === 0
    ) {
      logger.info('Payment applied (no interest, no indexation)', { itemId: actualPaymentItemId, paymentDate });
    }
  }

  if (remainingToAllocate > 0) {
    logger.warn('Payment amount exceeded all contractual items', {
      actualPaymentItemId,
      unallocated: remainingToAllocate,
    });
  }

  return { success: true, subitemsCreated };
}
