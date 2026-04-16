export const CONTRACTUAL_PAYMENTS = {
  boardId: "5092167973",
  items: {
    paymentDue: "numeric_mm0tv8dx",
    /** Contractual principal - used for first subitem's remaining principal before payment */
    principalDue: "numeric_mm0tv8dx",
    indexationPaymentDue: "numeric_mm117vgw",
    /** Contract link column - links to the same contract as Actual Payments */
    contractLink: "board_relation_mm0tcdy3",
    /** Contractual due date (e.g. display / sorting) */
    contractualDueDate: "date_mm0t3zcj",
    /** Index-linked status: "V" = index-linked, "X" = not index-linked (indexation always 0) */
    indexLinkedStatus: "color_mm11deyr",
    /** Interest-charge status: "V" = late days/interest as usual, "X" = no interest charge for this item */
    interestChargeStatus: "color_mm2chzyh",
    /** דירה | רישום זכויות — receipts only clear lines with the same category */
    paymentCategory: "color_mm2b2889",
    /** קרן לפני מע"מ — principal balance for allocation (interest/indexation/principal); overrides legacy payment column when non-zero */
    principalBeforeVat: "numeric_mm2bhrm1",
  } as const,
  subitems: {
    boardId: "5092168551",
    name: "name",
    actualPaymentName: "text_mm1jy3x7",
    /** Actual payment item ID (same as Actual Payments board pulse/item id) */
    actualPaymentItemId: "text_mm1y3p6f",
    /** When one receipt spans multiple contractual payments, all related subitems get label "כן" */
    splitPaymentIndicator: "color_mm1y2mwy",
    /** Original actual payment total (numeric_mm0tyhpc); not split across subitems */
    originalActualReceiptTotal: "numeric_mm1z9zy4",
    /** Split pre-VAT payment allocated to this subitem (interest + indexation + principal) */
    actualReceipt: "numeric_mm1bp0ht",
    /** Split payment after VAT for presentation only: actualReceipt × (1 + vatPercent) */
    splitPaymentAfterVat: "numeric_mm2dhfrf",
    remainingInterestBeforePayment: "numeric_mm1fws8v",
    remainingIndexationBeforePayment: "numeric_mm1f31qx",
    remainingPrincipalBeforePayment: "numeric_mm1fx9bf",
    interest: "numeric_mm1bkqds",
    indexLinkage: "numeric_mm19panw",
    principal: "formula_mm1bwstj",
    remainingInterest: "numeric_mm1cdy74",
    remainingIndexLinkage: "numeric_mm1cf2ws",
    remainingPrincipal: "numeric_mm1cz0x0",
    /** Amount of principal paid in this payment */
    principalPayment: "numeric_mm1srrt5",
    /** Days from contractual due (after grace) used for interest accrual — matches interest formula */
    interestLateDays: "numeric_mm1snkkb",
    /** Index change (current / previous − 1) × 100 — previous = contract base or prior payment index */
    indexChangePercent: "numeric_mm1sy5px",
    /** מדד עדכני — index value for the payment date (Indices board) */
    currentIndexValue: "numeric_mm2b6jvk",
    /** מדד בסיס — index used as denominator in indexation (contract base or prior payment date index) */
    indexationBaseIndex: "numeric_mm2b58jt",
    /** Same category as source actual payment (דירה | רישום זכויות) */
    paymentCategory: "color_mm2br0yj",
    /** % מע"מ — copied from Actual Payments (numeric_mm2bnnc8) */
    vatPercent: "numeric_mm2bkbnx",
    /** יתרת תשלום אחרי מע"מ — (interest + indexation + principal paid this line) × (1 + VAT) */
    remainingPaymentAfterVat: "numeric_mm2b5r02",
  } as const,
} as const;

/** Contracts board - for interest rate and base index */
export const CONTRACTS_BOARD = {
  boardId: "5092167972",
  columns: {
    interestRatePercent: "numeric_mm1fn125",
    baseIndex: "numeric_mm1f17hf",
    /** Date used to fetch base index from Indices board (before/after 15th rules). Overrides baseIndex when set. */
    baseIndexDate: "date_mm1js4d4",
  } as const,
} as const;

export const ACTUAL_PAYMENTS = {
  boardId: "5092169396",
  columns: {
    name: "name",
    /** Item ID on the pulse (mirrors the id used when creating subitem links) */
    pulseId: "pulse_id_mm1ygfs7",
    receiptAmount: "numeric_mm0tyhpc",
    document: "file_mm0tcpmv",
    receiptType: "dropdown_mm0tv7z7",
    receiptDate: "date_mm0tny6b",
    /** When set, replaces receipt date for index period, interest, and subitem date (allocation treats payment as of this date). */
    indexPaymentDate: "date_mm2bcmy6",
    notes: "text_mm0tyq8q",
    contracts: "board_relation_mm0t5e32",
    contractId: "text_mm18ghg5",
    receiptClearanceStatus: "color_mm14hrv2",
    amountForInterest: "numeric_mm1421wt",
    amountForIndexLinkage: "numeric_mm14ep9e",
    amountForPrincipal: "numeric_mm14bdn5",
    /** Actual payment amount before VAT — copied to subitems actual payment column (numeric_mm1bp0ht) */
    receiptAmountBeforeVat: "numeric_mm2bfks3",
    /** דירה | רישום זכויות — which contractual stream this receipt pays */
    paymentCategory: "color_mm2b4z50",
    /** % מע"מ — VAT rate; mirrored on contractual subitems (numeric_mm2bkbnx) */
    vatPercent: "numeric_mm2bnnc8",
  } as const,
} as const;

/** Index values board - stores CBS price indices (CPI, Construction Input) */
export const INDEX_BOARD = {
  boardId: "5092654858",
  groups: {
    constructionInput: "topics",
    consumerPrice: "group_title",
  } as const,
  columns: {
    indexValue: "numeric_mm14kv1j",
    updateDate: "date4",
  } as const,
} as const;

export type ContractualPaymentsItemColumnKey = keyof typeof CONTRACTUAL_PAYMENTS.items;
export type ContractualPaymentsSubitemColumnKey = keyof typeof CONTRACTUAL_PAYMENTS.subitems;
export type ActualPaymentsColumnKey = keyof typeof ACTUAL_PAYMENTS.columns;
