/**
 * Payment allocation logic: allocates actual payments across contractual payment items
 * in order: Interest → Indexation → Principal.
 *
 * Interest and indexation balances are calculated per payment from:
 * - Interest: Remaining_Principal × (r/365) × Late_Days + previous remaining interest
 * - Indexation: Remaining_Principal × (Current_Index/Previous_Index - 1) + previous remaining indexation
 *   (Previous_Index = contract base for first subitem, index from previous subitem's payment date for rest)
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

export interface ActualPaymentItem {
  id: string;
  name: string;
  receiptAmount: number;
  receiptDate: string | null;
  linkedContractIds: number[];
}

export interface ContractualPaymentItem {
  id: string;
  name: string;
  paymentOrder: number; // 1, 2, 3, 4... from item name
  paymentDue: number;
  indexationPaymentDue: number;
  principal: number;
  contractualDueDate: string | null;
  /** "V" = index-linked, "X" = not index-linked (indexation always 0). Default "V" when unset. */
  indexLinkedStatus: "V" | "X";
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
        column_values(ids: ["${ACTUAL_PAYMENTS.columns.receiptAmount}", "${ACTUAL_PAYMENTS.columns.receiptDate}", "${ACTUAL_PAYMENTS.columns.contracts}", "${ACTUAL_PAYMENTS.columns.contractId}"]) {
          id
          value
          type
          ... on BoardRelationValue {
            linked_item_ids
          }
        }
      }
    }
  `;

  type ColumnValue = { id: string; value?: string | null; type: string; linked_item_ids?: string[] };
  const data = await mondayQuery<{ items: Array<{ id: string; name: string; column_values: ColumnValue[] }> }>(query, { itemId: parseInt(itemId, 10) });

  const item = data.items?.[0];
  if (!item) {
    logger.warn('Actual payment item not found', { itemId });
    return null;
  }

  let receiptAmount = 0;
  let receiptDate: string | null = null;
  let linkedContractIds: number[] = [];
  let contractIdText: string | null = null;

  for (const cv of item.column_values) {
    if (cv.id === ACTUAL_PAYMENTS.columns.receiptAmount) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        receiptAmount = parseFloat(parsed.value ?? parsed) || 0;
      } catch {
        receiptAmount = parseFloat(cv.value ?? '') || 0;
      }
    } else if (cv.id === ACTUAL_PAYMENTS.columns.receiptDate) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        receiptDate = parsed.date ?? null;
      } catch {
        receiptDate = cv.value || null;
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
    receiptDate,
    linkedContractIds,
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
  contractId: number
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

  /** Parse payment order from item name: "1" -> 1, "2 5" -> 2, "3 1" -> 3, "4" -> 4 */
  function parsePaymentOrder(name: string): number {
    const match = name?.trim().match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 999;
  }

  const contractual: ContractualPaymentItem[] = items.map((item) => {
    let paymentDue = 0;
    let principalDue = 0;
    let indexationPaymentDue = 0;
    let contractualDueDate: string | null = null;
    let indexLinkedStatus: "V" | "X" = "V";

    for (const cv of item.column_values) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        if (cv.id === CONTRACTUAL_PAYMENTS.items.contractualDueDate) {
          contractualDueDate = parsed.date ?? null;
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexLinkedStatus) {
          const labelRaw = (cv as ContractualColumnValue).label ?? (cv as ContractualColumnValue).text ?? parsed.label ?? parsed.additional_info?.label;
          const label = (labelRaw ?? "").toString().trim().toUpperCase();
          indexLinkedStatus = label === "X" ? "X" : "V";
        } else {
          const val = parseFloat(parsed.value ?? parsed) || 0;
          if (cv.id === CONTRACTUAL_PAYMENTS.items.paymentDue) paymentDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.principalDue) principalDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexationPaymentDue) indexationPaymentDue = val;
        }
      } catch {
        if (cv.id === CONTRACTUAL_PAYMENTS.items.contractualDueDate) {
          contractualDueDate = cv.value ?? null;
        } else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexLinkedStatus) {
          const labelRaw = (cv as ContractualColumnValue).label ?? (cv as ContractualColumnValue).text ?? cv.value;
          const label = (labelRaw ?? "").toString().trim().toUpperCase();
          indexLinkedStatus = label === "X" ? "X" : "V";
        } else {
          const val = parseFloat(cv.value ?? '') || 0;
          if (cv.id === CONTRACTUAL_PAYMENTS.items.paymentDue) paymentDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.principalDue) principalDue = val;
          else if (cv.id === CONTRACTUAL_PAYMENTS.items.indexationPaymentDue) indexationPaymentDue = val;
        }
      }
    }

    // Principal for first subitem comes from contractual principal column (numeric_mm0tv8dx)
    const principal = round(Math.max(0, principalDue || paymentDue));
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
    };
  });

  // Sort by payment order (1, 2, 3, 4...) so we fill the first payment before moving to the next
  contractual.sort((a, b) => a.paymentOrder - b.paymentOrder);

  return contractual;
}

// ─── Index period for payment date ───────────────────────────────────────────
/**
 * Index is published every month on the 15th for the previous month.
 * - If payment date is before the 15th: use index of two months earlier.
 * - If payment date is on or after the 15th: use index of previous month.
 * Returns period as "MM-YYYY" to match Indices board item names.
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
 * If target not yet published (e.g. payment on 16th, data not in yet), uses most recent available index.
 * Always takes the most updated index we have for the date we are looking for.
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
  parentOriginalPrincipal: number
): Promise<PreviousSubitemBalances> {
  const sub = CONTRACTUAL_PAYMENTS.subitems;
  const query = `
    query GetSubitems($parentId: ID!) {
      items(ids: [$parentId]) {
        subitems {
          name
          column_values(ids: ["${sub.remainingPrincipal}", "${sub.remainingInterest}", "${sub.remainingIndexLinkage}"]) {
            id
            value
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
        column_values: Array<{ id: string; value: string }>;
        created_at: string;
      }>;
    }>;
  }>(query, { parentId: parentItemId });

  const subitems = data.items?.[0]?.subitems ?? [];
  if (subitems.length === 0) {
    return {
      remainingPrincipal: parentOriginalPrincipal,
      remainingInterest: 0,
      remainingIndexation: 0,
      previousSubitemPaymentDate: null,
    };
  }

  const latest = subitems.sort(
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

function computeLateInterest(
  remainingPrincipal: number,
  interestRatePercent: number,
  contractualDueDate: string | null,
  paymentDate: string
): number {
  if (!contractualDueDate || remainingPrincipal <= 0) return 0;

  const due = new Date(contractualDueDate);
  const paid = new Date(paymentDate);
  const diffMs = paid.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= GRACE_DAYS) return 0;

  const r = interestRatePercent / 100;
  const interest = remainingPrincipal * (r / 365) * diffDays;
  const result = round(interest);

  logger.info('Interest', {
    formula: 'Remaining_Principal × (r / 365) × Late_Days',
    calculation: `${remainingPrincipal} × (${r} / 365) × ${diffDays} = ${result}`,
  });

  return result;
}

// ─── Compute indexation balance ──────────────────────────────────────────────

function computeIndexationBalance(
  remainingPrincipal: number,
  currentIndex: number,
  previousIndex: number
): number {
  if (remainingPrincipal <= 0 || previousIndex <= 0) return 0;

  const ratio = currentIndex / previousIndex;
  const indexation = remainingPrincipal * (ratio - 1);
  let result = round(indexation);

  if (result < 0) result = 0;

  logger.info('Indexation', {
    ratio: `${currentIndex} / ${previousIndex} = ${ratio.toFixed(4)}`,
    calculation: `${remainingPrincipal} × (${ratio.toFixed(4)} - 1) = ${remainingPrincipal} × ${(ratio - 1).toFixed(4)} = ${result}`,
  });

  return result;
}

// ─── Compute balances before payment ─────────────────────────────────────────

export async function computeBalancesBeforePayment(
  parentItemId: string,
  contractualItem: ContractualPaymentItem,
  paymentDate: string,
  contractDetails: ContractDetails | null,
  currentIndex: number,
  currentIndexPeriod: string
): Promise<{ balances: BalancesBeforePayment; remaining: RemainingBalances }> {
  const previous = await getPreviousSubitemBalances(parentItemId, contractualItem.principal);

  const remainingPrincipalBefore = previous.remainingPrincipal;
  const interestRatePercent = contractDetails?.interestRatePercent ?? 0;
  const contractBaseIndex = contractDetails?.baseIndex ?? 100;

  let previousIndex: number;
  let baseIndexPeriod: string | null = null;
  if (!previous.previousSubitemPaymentDate) {
    previousIndex = contractBaseIndex;
    baseIndexPeriod = contractDetails?.baseIndexPeriod ?? null;
  } else {
    const prevDateIso = parseSubitemNameToIsoDate(previous.previousSubitemPaymentDate);
    const prevIndexResult = prevDateIso ? await fetchIndexForPaymentDate(prevDateIso) : null;
    previousIndex = prevIndexResult?.value ?? contractBaseIndex;
    baseIndexPeriod = prevIndexResult?.period ?? null;
    if (!prevIndexResult && prevDateIso) {
      logger.warn('Could not fetch index for previous subitem date, falling back to contract base index', {
        previousSubitemPaymentDate: previous.previousSubitemPaymentDate,
        contractBaseIndex,
      });
    }
  }

  const calculatedInterest = computeLateInterest(
    remainingPrincipalBefore,
    interestRatePercent,
    contractualItem.contractualDueDate,
    paymentDate
  );
  const remainingInterestBefore = round(calculatedInterest + previous.remainingInterest);

  let calculatedIndexation = 0;
  let remainingIndexationBefore = 0;

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
      remainingPrincipalBefore,
      currentIndex,
      previousIndex
    );
    remainingIndexationBefore = round(calculatedIndexation + previous.remainingIndexation);
  }

  const balances: BalancesBeforePayment = {
    remainingPrincipalBefore,
    remainingInterestBefore,
    remainingIndexationBefore,
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
  const { principal, interest, indexation } = initialBalances;

  let interestPaid = round(Math.min(remaining, interest));
  const afterInterest = round(remaining - interestPaid);
  remaining = afterInterest;

  let indexationPaid = round(Math.min(remaining, indexation));
  const afterIndexation = round(remaining - indexationPaid);
  remaining = afterIndexation;

  let principalPaid = round(Math.min(remaining, principal));
  const afterPrincipal = round(remaining - principalPaid);
  remaining = afterPrincipal;

  const amountUsed = round(interestPaid + indexationPaid + principalPaid);

  return {
    principalPaid,
    interestPaid,
    indexationPaid,
    remainingPrincipal: round(principal - principalPaid),
    remainingInterest: round(interest - interestPaid),
    remainingIndexation: round(indexation - indexationPaid),
    amountUsed,
  };
}

// ─── Create subitem payload ──────────────────────────────────────────────────

export function createSubitemPayload(
  paymentDate: string,
  allocation: AllocationResult,
  actualAmountAllocated: number,
  balancesBefore: BalancesBeforePayment,
  actualPaymentName: string
): SubitemPayload {
  const sub = CONTRACTUAL_PAYMENTS.subitems;
  // Monday API expects numeric columns as plain strings: "column_id": "123"
  const columnValues: Record<string, string> = {
    [sub.actualPaymentName]: actualPaymentName || '',
    [sub.actualReceipt]: String(actualAmountAllocated),
    [sub.remainingPrincipalBeforePayment]: String(balancesBefore.remainingPrincipalBefore),
    [sub.remainingInterestBeforePayment]: String(balancesBefore.remainingInterestBefore),
    [sub.remainingIndexationBeforePayment]: String(balancesBefore.remainingIndexationBefore),
    [sub.interest]: String(allocation.interestPaid),
    [sub.indexLinkage]: String(allocation.indexationPaid),
    [sub.remainingInterest]: String(allocation.remainingInterest),
    [sub.remainingIndexLinkage]: String(allocation.remainingIndexation),
    [sub.remainingPrincipal]: String(allocation.remainingPrincipal),
  };
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

  if (!actualPayment.receiptAmount || actualPayment.receiptAmount <= 0) {
    return { success: false, subitemsCreated: 0, error: 'Invalid or missing receipt amount' };
  }

  const contractId = extractContractId(actualPayment);
  if (contractId === null) {
    return { success: false, subitemsCreated: 0, error: 'No linked contract on actual payment item' };
  }

  const contractualItems = await findMatchingContractualItems(contractId);
  if (contractualItems.length === 0) {
    return { success: false, subitemsCreated: 0, error: 'No matching contractual payment items found' };
  }

  const paymentDate =
    actualPayment.receiptDate ??
    new Date().toISOString().slice(0, 10);

  const [contractDetails, indexResult] = await Promise.all([
    fetchContractDetails(contractId),
    fetchIndexForPaymentDate(paymentDate),
  ]);

  const currentIndex = indexResult?.value ?? 100;
  if (!indexResult) {
    logger.warn('No index from Monday board, using 100 for indexation');
  }

  let remainingToAllocate = round(actualPayment.receiptAmount);
  let subitemsCreated = 0;

  for (const item of contractualItems) {
    if (remainingToAllocate <= 0) break;

    const { balances, remaining } = await computeBalancesBeforePayment(
      item.id,
      item,
      paymentDate,
      contractDetails,
      currentIndex,
      indexResult?.period ?? 'N/A'
    );

    const totalRemaining = round(remaining.principal + remaining.interest + remaining.indexation);

    if (totalRemaining <= 0) continue;

    const allocation = allocatePayment(remainingToAllocate, remaining);
    if (allocation.amountUsed <= 0) break;

    const payload = createSubitemPayload(
      paymentDate,
      allocation,
      allocation.amountUsed,
      balances,
      actualPayment.name
    );

    await createSubitem(item.id, payload);
    subitemsCreated++;

    if (item.indexLinkedStatus === "X" && allocation.interestPaid === 0 && allocation.indexationPaid === 0) {
      logger.info('Payment applied (no interest, no indexation)', { itemId: actualPaymentItemId, paymentDate });
    }

    remainingToAllocate = round(remainingToAllocate - allocation.amountUsed);
  }

  if (remainingToAllocate > 0) {
    logger.warn('Payment amount exceeded all contractual items', {
      actualPaymentItemId,
      unallocated: remainingToAllocate,
    });
  }

  return { success: true, subitemsCreated };
}
