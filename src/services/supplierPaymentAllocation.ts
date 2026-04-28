import { INDEX_BOARD } from '../config/config';
import { logger } from '../logger';
import { mondayQuery } from './mondayApi';

const ROUND = 2;

function round(value: number): number {
  return Math.round(value * 10 ** ROUND) / 10 ** ROUND;
}

function parseNumberish(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const normalized = value
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumericIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function statusIndicatesTrue(labelText: string): boolean {
  const normalized = labelText.trim().toUpperCase();
  if (!normalized) return false;
  return (
    normalized === 'V' ||
    normalized === 'TRUE' ||
    normalized === 'YES' ||
    normalized === 'כן' ||
    normalized.includes('✅') ||
    normalized.includes('✔') ||
    normalized.includes('☑')
  );
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

/**
 * Index is published every month on the 15th for the previous month.
 * - If payment date is before the 15th: use index of two months earlier.
 * - If payment date is on or after the 15th: use index of previous month.
 */
function getIndexPeriodForPaymentDate(paymentDate: string): string {
  const d = new Date(paymentDate);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
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

function getPeriodSortKey(period: string): string {
  const [mm, yyyy] = period.split('-');
  return `${yyyy}-${mm}`;
}

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

  logger.info('Supplier indexation formula', {
    formula: 'actualPayment × (currentIndex / baseIndex - 1)',
    calculation: `${indexationBaseAmount} × (${currentIndex} / ${previousIndex} - 1) = ${round(indexation)}`,
    clampedResult: result,
  });

  return result;
}

async function createSubitem(
  parentItemId: string,
  name: string,
  columnValues: Record<string, unknown>
): Promise<string> {
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
    itemName: name,
    columnValues: JSON.stringify(columnValues),
  });
  const id = data.create_subitem?.id;
  if (!id) {
    throw new Error('Failed to create subitem: no ID returned');
  }
  return id;
}

const SUPPLIER_PAYMENTS_BOARD_ID = '5092501259';
const SUPPLIER_CONTRACTS_BOARD_ID = '5092502219';

const SUPPLIER_COL = {
  contractRelation: 'board_relation_mm113h6t',
  actualPayment: 'numeric_mm2krmyr',
  contractualPayment: 'formula_mm1t1c7q',
  remainingToPay: 'numeric_mm2sqmg9',
  paymentDate: 'date_mm2kxjbz',
  indexedFlag: 'color_mm2eknww',
  processingStatus: 'color_mm2kj8ad',
} as const;

const SUPPLIER_CONTRACT_COL = {
  indexationType: 'color_mm2sntzp',
  baseIndexDate: 'date_mm2sqkz6',
} as const;

const SUPPLIER_SUBITEM_COL = {
  actualPayment: 'numeric_mm2szfpk',
  indexedPayment: 'numeric_mm2ks9zk',
  principalPayment: 'numeric_mm2k9k90',
  baseIndex: 'numeric_mm2sdepm',
  updatedIndex: 'numeric_mm2sarw5',
} as const;

const INDEX_GROUP_BY_TYPE: Record<string, string> = {
  'מדד המחירים לצרכן': 'מדד המחירים לצרכן',
  'מדד תשומות הבניה': 'מדד תשומות הבניה',
};

interface SupplierWebhookItem {
  id: string;
  paymentDate: string | null;
  actualPayment: number;
  contractualPayment: number;
  remainingToPay: number;
  remainingToPayIsEmpty: boolean;
  shouldApplyIndexation: boolean;
  linkedContractId: number | null;
}

interface SupplierContractIndexationInfo {
  indexationType: string | null;
  baseIndexDate: string | null;
}

export interface ApplySupplierPaymentInput {
  supplierPaymentItemId: string;
}

export interface ApplySupplierPaymentResult {
  success: boolean;
  subitemId?: string;
  principalPayment?: number;
  indexedPayment?: number;
  error?: string;
}

export interface CalculateSupplierPaymentInput {
  supplierPaymentItemId: string;
}

export interface CalculateSupplierPaymentResult {
  success: boolean;
  principalPayment?: number;
  indexedPayment?: number;
  totalPayment?: number;
  error?: string;
}

async function updateSupplierSourceItemStatus(
  itemId: string,
  statusLabel: 'נוסף' | 'כשל',
  remainingToPay?: number,
  clearActualPayment?: boolean
): Promise<void> {
  const values: Record<string, unknown> = {
    [SUPPLIER_COL.processingStatus]: { label: statusLabel },
  };
  if (typeof remainingToPay === 'number') {
    values[SUPPLIER_COL.remainingToPay] = String(round(remainingToPay));
  }
  if (clearActualPayment) {
    values[SUPPLIER_COL.actualPayment] = '';
  }

  const mutation = `
    mutation UpdateSupplierItem($itemId: ID!, $boardId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        item_id: $itemId,
        board_id: $boardId,
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await mondayQuery(mutation, {
    itemId: parseInt(itemId, 10),
    boardId: parseInt(SUPPLIER_PAYMENTS_BOARD_ID, 10),
    columnValues: JSON.stringify(values),
  });
}

async function fetchSupplierWebhookItem(itemId: string): Promise<SupplierWebhookItem | null> {
  const query = `
    query GetSupplierPaymentItem($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        column_values(ids: ["${SUPPLIER_COL.contractRelation}", "${SUPPLIER_COL.actualPayment}", "${SUPPLIER_COL.contractualPayment}", "${SUPPLIER_COL.remainingToPay}", "${SUPPLIER_COL.paymentDate}", "${SUPPLIER_COL.indexedFlag}"]) {
          id
          type
          value
          text
          ... on FormulaValue {
            display_value
          }
          ... on BoardRelationValue {
            linked_item_ids
          }
          ... on StatusValue {
            label
            index
          }
        }
      }
    }
  `;

  type Cv = {
    id: string;
    type?: string | null;
    value?: string | null;
    text?: string | null;
    display_value?: string | null;
    label?: string | null;
    index?: number | null;
    linked_item_ids?: string[];
  };
  const data = await mondayQuery<{ items: Array<{ id: string; column_values: Cv[] }> }>(query, {
    itemId: parseInt(itemId, 10),
  });
  const item = data.items?.[0];
  if (!item) return null;

  let actualPayment = 0;
  let contractualPayment = 0;
  let remainingToPay = 0;
  let remainingToPayIsEmpty = true;
  let paymentDate: string | null = null;
  let shouldApplyIndexation = false;
  let linkedContractId: number | null = null;

  for (const cv of item.column_values) {
    if (cv.id === SUPPLIER_COL.contractRelation) {
      const linkedIds =
        cv.linked_item_ids?.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id)) ??
        parseBoardRelationIds(cv.value ?? null);
      linkedContractId = linkedIds[0] ?? null;
    } else if (cv.id === SUPPLIER_COL.actualPayment) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        actualPayment = parseFloat(parsed.value ?? parsed) || 0;
      } catch {
        actualPayment = parseFloat(cv.value ?? '') || 0;
      }
    } else if (cv.id === SUPPLIER_COL.contractualPayment) {
      if (typeof cv.display_value === 'string' && cv.display_value.trim() !== '') {
        contractualPayment = parseNumberish(cv.display_value);
      } else if (typeof cv.text === 'string' && cv.text.trim() !== '') {
        contractualPayment = parseNumberish(cv.text);
      } else {
        try {
          const parsed = JSON.parse(cv.value || '{}');
          contractualPayment = parseNumberish(
            parsed.value ??
            parsed.display_value ??
            parsed.text ??
            parsed
          );
        } catch {
          contractualPayment = parseNumberish(cv.value ?? '');
        }
      }

      logger.info('Supplier contractual formula raw', {
        type: cv.type ?? null,
        displayValue: cv.display_value ?? null,
        text: cv.text ?? null,
        value: cv.value ?? null,
        parsedContractualPayment: contractualPayment,
      });
    } else if (cv.id === SUPPLIER_COL.remainingToPay) {
      remainingToPayIsEmpty = !cv.value || cv.value.trim() === '';
      try {
        const parsed = JSON.parse(cv.value || '{}');
        remainingToPay = parseFloat(parsed.value ?? parsed) || 0;
      } catch {
        remainingToPay = parseFloat(cv.value ?? '') || 0;
      }
    } else if (cv.id === SUPPLIER_COL.paymentDate) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        paymentDate = parsed.date ? String(parsed.date).slice(0, 10) : null;
      } catch {
        paymentDate = typeof cv.value === 'string' && cv.value.trim() ? cv.value.slice(0, 10) : null;
      }
    } else if (cv.id === SUPPLIER_COL.indexedFlag) {
      const labelOrText = (cv.label ?? cv.text ?? '').toString();
      const statusIndex = toNumericIndex(cv.index);
      shouldApplyIndexation = statusIndicatesTrue(labelOrText);

      logger.info('Supplier indexation status raw', {
        label: cv.label ?? null,
        text: cv.text ?? null,
        index: cv.index ?? null,
        value: cv.value ?? null,
      });

      if (!shouldApplyIndexation) {
        try {
          const parsed = JSON.parse(cv.value || '{}');
          const innerLabel = (parsed.label ?? parsed.text ?? '').toString();
          const innerIndex =
            toNumericIndex(parsed.index) ??
            toNumericIndex(parsed?.additional_info?.index);
          shouldApplyIndexation =
            statusIndicatesTrue(innerLabel) ||
            (statusIndex !== null && innerIndex !== null && innerIndex === statusIndex) ||
            (statusIndex === null && innerIndex === 1);
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    id: item.id,
    paymentDate,
    actualPayment: round(actualPayment),
    contractualPayment: round(contractualPayment),
    remainingToPay: round(remainingToPay),
    remainingToPayIsEmpty,
    shouldApplyIndexation,
    linkedContractId,
  };
}

async function fetchSupplierContractIndexationInfo(contractId: number): Promise<SupplierContractIndexationInfo | null> {
  const query = `
    query GetSupplierContract($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        column_values(ids: ["${SUPPLIER_CONTRACT_COL.indexationType}", "${SUPPLIER_CONTRACT_COL.baseIndexDate}"]) {
          id
          value
          text
          ... on StatusValue {
            label
            index
          }
        }
      }
    }
  `;

  type Cv = { id: string; value?: string | null; text?: string | null; label?: string | null; index?: number | null };
  const data = await mondayQuery<{ items: Array<{ column_values: Cv[] }> }>(query, {
    itemId: contractId,
  });
  const item = data.items?.[0];
  if (!item) return null;

  let indexationType: string | null = null;
  let baseIndexDate: string | null = null;
  let indexationTypeIndex: number | null = null;

  for (const cv of item.column_values) {
    if (cv.id === SUPPLIER_CONTRACT_COL.indexationType) {
      indexationType = (cv.label ?? cv.text ?? '').toString().trim() || null;
      indexationTypeIndex = toNumericIndex(cv.index);
      if (!indexationType) {
        try {
          const parsed = JSON.parse(cv.value || '{}');
          indexationType = (
            parsed.label ??
            parsed.text ??
            parsed.additional_info?.label ??
            parsed.additional_info?.text ??
            ''
          ).toString().trim() || null;
          indexationTypeIndex =
            indexationTypeIndex ??
            toNumericIndex(parsed.index) ??
            toNumericIndex(parsed.additional_info?.index);
        } catch {
          // ignore
        }
      }

      logger.info('Supplier contract indexation-type raw', {
        contractId,
        label: cv.label ?? null,
        text: cv.text ?? null,
        index: cv.index ?? null,
        value: cv.value ?? null,
      });
    } else if (cv.id === SUPPLIER_CONTRACT_COL.baseIndexDate) {
      try {
        const parsed = JSON.parse(cv.value || '{}');
        baseIndexDate = parsed.date ? String(parsed.date).slice(0, 10) : null;
      } catch {
        baseIndexDate = typeof cv.value === 'string' && cv.value.trim() ? cv.value.slice(0, 10) : null;
      }
    }
  }

  if (!indexationType && indexationTypeIndex !== null) {
    try {
      const labelsQuery = `
        query SupplierContractTypeLabels($boardId: ID!, $columnId: String!) {
          boards(ids: [$boardId]) {
            columns(ids: [$columnId]) {
              settings_str
            }
          }
        }
      `;
      const labelsData = await mondayQuery<{
        boards: Array<{ columns: Array<{ settings_str?: string | null }> }>;
      }>(labelsQuery, {
        boardId: parseInt(SUPPLIER_CONTRACTS_BOARD_ID, 10),
        columnId: SUPPLIER_CONTRACT_COL.indexationType,
      });
      const settingsStr = labelsData.boards?.[0]?.columns?.[0]?.settings_str ?? null;
      if (settingsStr) {
        const settings = JSON.parse(settingsStr) as { labels?: Record<string, string> };
        const mapped = settings.labels?.[String(indexationTypeIndex)] ?? null;
        indexationType = typeof mapped === 'string' ? mapped.trim() || null : null;
      }
    } catch (err) {
      logger.warn('Failed to resolve supplier contract indexation type from labels map', {
        contractId,
        indexationTypeIndex,
        err,
      });
    }
  }

  logger.info('Supplier contract indexation-type resolved', {
    contractId,
    indexationType,
    indexationTypeIndex,
    baseIndexDate,
  });

  return { indexationType, baseIndexDate };
}

async function fetchIndexForPaymentDateByGroup(
  paymentDate: string,
  groupTitle: string
): Promise<{ value: number; period: string } | null> {
  const targetPeriod = getIndexPeriodForPaymentDate(paymentDate);
  const col = INDEX_BOARD.columns.indexValue;
  const allItems: Array<{
    name: string;
    group?: { id: string; title: string } | null;
    column_values: Array<{ id: string; value: string }>;
  }> = [];
  let cursor: string | null = null;

  type Page = { cursor: string | null; items: typeof allItems };
  do {
    const queryStr: string = cursor
      ? `
        query GetIndexItemsByGroupNext($cursor: String!) {
          next_items_page(cursor: $cursor, limit: 500) {
            cursor
            items {
              name
              group { id title }
              column_values(ids: ["${col}"]) { id value }
            }
          }
        }
      `
      : `
        query GetIndexItemsByGroup($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 500) {
              cursor
              items {
                name
                group { id title }
                column_values(ids: ["${col}"]) { id value }
              }
            }
          }
        }
      `;

    let page: Page | undefined;
    if (cursor) {
      const res: { next_items_page: Page } = await mondayQuery(queryStr, { cursor });
      page = res.next_items_page;
    } else {
      const res: { boards: Array<{ items_page: Page }> } = await mondayQuery(queryStr, {
        boardId: INDEX_BOARD.boardId,
      });
      page = res.boards?.[0]?.items_page;
    }
    cursor = page?.cursor ?? null;
    allItems.push(...(page?.items ?? []));
  } while (cursor);

  const targetGroup = groupTitle.trim();
  const withPeriod = allItems
    .filter((item) => item.group?.title?.trim() === targetGroup)
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
  let usedFallback = false;
  if (!match) {
    const targetKey = getPeriodSortKey(targetPeriod);
    const availableForTarget = withPeriod
      .filter((x) => getPeriodSortKey(x.period) <= targetKey)
      .sort((a, b) =>
        getPeriodSortKey(b.period).localeCompare(getPeriodSortKey(a.period))
      );
    match = availableForTarget[0];
    usedFallback = true;
  }
  if (match) {
    logger.info('Supplier index fetched', {
      groupTitle: targetGroup,
      sourceDate: paymentDate,
      targetPeriod,
      usedPeriod: match.period,
      value: match.value,
      usedFallback,
    });
  } else {
    logger.warn('Supplier index not found', {
      groupTitle: targetGroup,
      sourceDate: paymentDate,
      targetPeriod,
    });
  }
  return match ?? null;
}

async function fetchLatestIndexByGroup(
  groupTitle: string
): Promise<{ value: number; period: string } | null> {
  const col = INDEX_BOARD.columns.indexValue;
  const allItems: Array<{
    name: string;
    group?: { id: string; title: string } | null;
    column_values: Array<{ id: string; value: string }>;
  }> = [];
  let cursor: string | null = null;

  type Page = { cursor: string | null; items: typeof allItems };
  do {
    const queryStr: string = cursor
      ? `
        query GetLatestIndexItemsByGroupNext($cursor: String!) {
          next_items_page(cursor: $cursor, limit: 500) {
            cursor
            items {
              name
              group { id title }
              column_values(ids: ["${col}"]) { id value }
            }
          }
        }
      `
      : `
        query GetLatestIndexItemsByGroup($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 500) {
              cursor
              items {
                name
                group { id title }
                column_values(ids: ["${col}"]) { id value }
              }
            }
          }
        }
      `;

    let page: Page | undefined;
    if (cursor) {
      const res: { next_items_page: Page } = await mondayQuery(queryStr, { cursor });
      page = res.next_items_page;
    } else {
      const res: { boards: Array<{ items_page: Page }> } = await mondayQuery(queryStr, {
        boardId: INDEX_BOARD.boardId,
      });
      page = res.boards?.[0]?.items_page;
    }
    cursor = page?.cursor ?? null;
    allItems.push(...(page?.items ?? []));
  } while (cursor);

  const targetGroup = groupTitle.trim();
  const candidates = allItems
    .filter((item) => item.group?.title?.trim() === targetGroup)
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
    .filter((x): x is NonNullable<typeof x> => x != null && x.value > 0)
    .sort((a, b) =>
      getPeriodSortKey(b.period).localeCompare(getPeriodSortKey(a.period))
    );

  const latest = candidates[0] ?? null;
  if (!latest) {
    logger.warn('Latest supplier index not found', { groupTitle: targetGroup });
    return null;
  }

  logger.info('Latest supplier index fetched', {
    groupTitle: targetGroup,
    latestPeriod: latest.period,
    value: latest.value,
  });
  return latest;
}

async function updateSupplierCalculationStatus(
  itemId: string,
  statusLabel: 'סיים' | 'כשל',
  totalPayment?: number
): Promise<void> {
  const values: Record<string, unknown> = {
    color_mm2vg75r: { label: statusLabel },
  };
  if (typeof totalPayment === 'number') {
    values.numeric_mm2v52mz = String(round(totalPayment));
  }

  const mutation = `
    mutation UpdateSupplierCalculation($itemId: ID!, $boardId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        item_id: $itemId,
        board_id: $boardId,
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await mondayQuery(mutation, {
    itemId: parseInt(itemId, 10),
    boardId: parseInt(SUPPLIER_PAYMENTS_BOARD_ID, 10),
    columnValues: JSON.stringify(values),
  });
}

export async function calculateSupplierPayment(
  input: CalculateSupplierPaymentInput
): Promise<CalculateSupplierPaymentResult> {
  const { supplierPaymentItemId } = input;

  try {
    const supplierItem = await fetchSupplierWebhookItem(supplierPaymentItemId);
    if (!supplierItem) {
      await updateSupplierCalculationStatus(supplierPaymentItemId, 'כשל');
      return { success: false, error: 'Supplier payment item not found' };
    }

    // Principal balance we want to close:
    // - Prefer numeric_mm2sqmg9 (remaining-to-pay) when it already exists
    // - On first run (blank remaining-to-pay), fall back to formula_mm1t1c7q (contractual principal)
    //
    // This route returns the amount to put into numeric_mm2krmyr such that applySupplierPayment
    // (indexation based on numeric_mm2krmyr) will reduce the principal balance to ~0, using
    // the same rounding rules.
    const principalToClose = round(
      supplierItem.remainingToPayIsEmpty
        ? supplierItem.contractualPayment
        : supplierItem.remainingToPay
    );
    if (principalToClose <= 0) {
      await updateSupplierCalculationStatus(supplierItem.id, 'כשל');
      return {
        success: false,
        error: supplierItem.remainingToPayIsEmpty
          ? 'Invalid contractual principal amount (formula_mm1t1c7q)'
          : 'Invalid remaining-to-pay amount (numeric_mm2sqmg9)',
      };
    }

    if (!supplierItem.linkedContractId) {
      await updateSupplierCalculationStatus(supplierItem.id, 'כשל');
      return { success: false, error: 'Missing linked supplier contract' };
    }

    const contractInfo = await fetchSupplierContractIndexationInfo(
      supplierItem.linkedContractId
    );
    const indexationTypeRaw = contractInfo?.indexationType ?? null;
    const indexationTypeGroup = indexationTypeRaw
      ? INDEX_GROUP_BY_TYPE[indexationTypeRaw]
      : null;
    const baseIndexDate = contractInfo?.baseIndexDate ?? null;

    if (!indexationTypeGroup || !baseIndexDate) {
      await updateSupplierCalculationStatus(supplierItem.id, 'כשל');
      return {
        success: false,
        error: 'Missing contract indexation type or base index date',
      };
    }

    const [latestIndex, baseIndex] = await Promise.all([
      fetchLatestIndexByGroup(indexationTypeGroup),
      fetchIndexForPaymentDateByGroup(baseIndexDate, indexationTypeGroup),
    ]);

    if (!latestIndex || !baseIndex) {
      await updateSupplierCalculationStatus(supplierItem.id, 'כשל');
      return { success: false, error: 'Could not resolve index values' };
    }

    const ratio = latestIndex.value / baseIndex.value;
    // applySupplierPayment computes:
    //   indexed = actual × (ratio - 1)
    //   principal = actual - indexed = actual × (2 - ratio)
    // To close a principal balance P, solve actual = P / (2 - ratio).
    const denom = 2 - ratio;
    if (!Number.isFinite(denom) || denom <= 0) {
      await updateSupplierCalculationStatus(supplierItem.id, 'כשל');
      return { success: false, error: 'Invalid index ratio for payment calculation' };
    }

    const step = 0.01;

    const simulate = (actualPayment: number) => {
      const indexed = computeIndexationBalance(
        actualPayment,
        latestIndex.value,
        baseIndex.value
      );
      const principal = round(Math.max(actualPayment - indexed, 0));
      const remaining = round(principalToClose - principal);
      return { indexedPayment: indexed, principalPayment: principal, remaining };
    };

    // Start from the closed-form solution, then adjust by cents to match rounding behavior.
    let totalPayment = round(principalToClose / denom);
    let sim = simulate(totalPayment);

    for (let i = 0; i < 500 && sim.remaining !== 0; i++) {
      totalPayment = round(totalPayment + (sim.remaining > 0 ? step : -step));
      sim = simulate(totalPayment);
    }

    const indexedPayment = sim.indexedPayment;
    const principalPayment = sim.principalPayment;

    logger.info('Supplier total payment calculation', {
      supplierPaymentItemId,
      principalToClose,
      principalPayment,
      indexedPayment,
      totalPayment,
      ratio,
      simulatedRemainingAfterPayment: round(principalToClose - principalPayment),
      baseIndexPeriod: baseIndex.period,
      baseIndexValue: baseIndex.value,
      latestIndexPeriod: latestIndex.period,
      latestIndexValue: latestIndex.value,
      indexationTypeRaw,
    });

    await updateSupplierCalculationStatus(supplierItem.id, 'סיים', totalPayment);

    return {
      success: true,
      principalPayment,
      indexedPayment,
      totalPayment,
    };
  } catch (err) {
    logger.warn('Failed to calculate supplier payment', {
      supplierPaymentItemId,
      err,
    });
    try {
      await updateSupplierCalculationStatus(supplierPaymentItemId, 'כשל');
    } catch (statusErr) {
      logger.warn('Failed to update supplier calculation status to failure', {
        supplierPaymentItemId,
        statusErr,
      });
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Internal supplier payment calculation error',
    };
  }
}

export async function applySupplierPayment(
  input: ApplySupplierPaymentInput
): Promise<ApplySupplierPaymentResult> {
  const { supplierPaymentItemId } = input;

  try {
    const supplierItem = await fetchSupplierWebhookItem(supplierPaymentItemId);
    if (!supplierItem) {
      await updateSupplierSourceItemStatus(supplierPaymentItemId, 'כשל');
      return { success: false, error: 'Supplier payment item not found' };
    }

    if (!supplierItem.paymentDate) {
      await updateSupplierSourceItemStatus(supplierItem.id, 'כשל');
      return { success: false, error: 'Missing payment date' };
    }
    if (supplierItem.actualPayment <= 0) {
      await updateSupplierSourceItemStatus(supplierItem.id, 'כשל');
      return { success: false, error: 'Invalid actual payment amount' };
    }

    const actualPaymentForSubitem = round(supplierItem.actualPayment);
    const remainingToPayBefore = supplierItem.remainingToPayIsEmpty
      ? supplierItem.contractualPayment
      : supplierItem.remainingToPay;
    let indexedPayment = 0;
    let currentIndex: { value: number; period: string } | null = null;
    let baseIndex: { value: number; period: string } | null = null;
    let indexationTypeGroup: string | null = null;
    let indexationTypeRaw: string | null = null;
    let baseIndexDate: string | null = null;

    if (!supplierItem.linkedContractId) {
      if (supplierItem.shouldApplyIndexation) {
        await updateSupplierSourceItemStatus(supplierItem.id, 'כשל');
        return { success: false, error: 'Missing linked supplier contract for indexation' };
      }
      logger.warn('Supplier payment without contract link (index context unavailable)', {
        supplierPaymentItemId,
      });
    } else {
      const contractInfo = await fetchSupplierContractIndexationInfo(
        supplierItem.linkedContractId
      );
      indexationTypeRaw = contractInfo?.indexationType ?? null;
      indexationTypeGroup = indexationTypeRaw
        ? INDEX_GROUP_BY_TYPE[indexationTypeRaw]
        : null;
      baseIndexDate = contractInfo?.baseIndexDate ?? null;

      if (indexationTypeGroup && baseIndexDate) {
        [currentIndex, baseIndex] = await Promise.all([
          fetchIndexForPaymentDateByGroup(supplierItem.paymentDate, indexationTypeGroup),
          fetchIndexForPaymentDateByGroup(baseIndexDate, indexationTypeGroup),
        ]);
      }

      logger.info('Supplier indexation context', {
        shouldApplyIndexation: supplierItem.shouldApplyIndexation,
        indexTypeRaw: indexationTypeRaw,
        indexTypeGroup: indexationTypeGroup,
        baseIndexDate,
        updatedIndexDate: supplierItem.paymentDate,
        baseIndexPeriod: baseIndex?.period ?? null,
        updatedIndexPeriod: currentIndex?.period ?? null,
        baseIndexValue: baseIndex?.value ?? null,
        updatedIndexValue: currentIndex?.value ?? null,
      });

      if (supplierItem.shouldApplyIndexation) {
        if (!indexationTypeGroup || !baseIndexDate) {
          await updateSupplierSourceItemStatus(supplierItem.id, 'כשל');
          return {
            success: false,
            error: 'Missing contract indexation type or base index date',
          };
        }
        if (!currentIndex || !baseIndex) {
          await updateSupplierSourceItemStatus(supplierItem.id, 'כשל');
          return { success: false, error: 'Could not resolve index values' };
        }

        indexedPayment = computeIndexationBalance(
          actualPaymentForSubitem,
          currentIndex.value,
          baseIndex.value
        );
      } else {
        logger.info('Supplier indexation skipped by status', {
          indexStatusExpected: 'V',
          paymentIndexationApplied: false,
        });
      }
    }

    const principalPayment = round(Math.max(actualPaymentForSubitem - indexedPayment, 0));
    const updatedRemainingToPay = round(remainingToPayBefore - principalPayment);

    logger.info('Supplier remaining-to-pay calculation', {
      remainingToPayIsEmpty: supplierItem.remainingToPayIsEmpty,
      remainingToPayBefore,
      contractualPaymentFromFormula: supplierItem.contractualPayment,
      principalPayment,
      updatedRemainingToPay,
    });

    const subitemId = await createSubitem(
      supplierItem.id,
      supplierItem.paymentDate,
      {
        [SUPPLIER_SUBITEM_COL.actualPayment]: String(actualPaymentForSubitem),
        [SUPPLIER_SUBITEM_COL.indexedPayment]: String(round(indexedPayment)),
        [SUPPLIER_SUBITEM_COL.principalPayment]: String(round(principalPayment)),
        [SUPPLIER_SUBITEM_COL.baseIndex]: String(round(baseIndex?.value ?? 0)),
        [SUPPLIER_SUBITEM_COL.updatedIndex]: String(round(currentIndex?.value ?? 0)),
      }
    );

    await updateSupplierSourceItemStatus(
      supplierItem.id,
      'נוסף',
      updatedRemainingToPay,
      true
    );

    return {
      success: true,
      subitemId,
      principalPayment,
      indexedPayment,
    };
  } catch (err) {
    logger.warn('Failed to apply supplier payment', {
      supplierPaymentItemId,
      err,
    });
    try {
      await updateSupplierSourceItemStatus(supplierPaymentItemId, 'כשל');
    } catch (statusErr) {
      logger.warn('Failed to update supplier payment status to failure', {
        supplierPaymentItemId,
        statusErr,
      });
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Internal supplier payment error',
    };
  }
}
