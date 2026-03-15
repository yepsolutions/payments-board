export const CONTRACTUAL_PAYMENTS = {
  boardId: "5092167973",
  items: {
    paymentDue: "numeric_mm0tv8dx",
    /** Contractual principal - used for first subitem's remaining principal before payment */
    principalDue: "numeric_mm0tv8dx",
    indexationPaymentDue: "numeric_mm117vgw",
    /** Contract link column - links to the same contract as Actual Payments */
    contractLink: "board_relation_mm0tcdy3",
    /** Contractual due date for interest calculation */
    contractualDueDate: "date_mm0t3zcj",
  } as const,
  subitems: {
    boardId: "5092168551",
    name: "name",
    actualReceipt: "numeric_mm1bp0ht",
    remainingInterestBeforePayment: "numeric_mm1fws8v",
    remainingIndexationBeforePayment: "numeric_mm1f31qx",
    remainingPrincipalBeforePayment: "numeric_mm1fx9bf",
    interest: "numeric_mm1bkqds",
    indexLinkage: "numeric_mm19panw",
    principal: "formula_mm1bwstj",
    remainingInterest: "numeric_mm1cdy74",
    remainingIndexLinkage: "numeric_mm1cf2ws",
    remainingPrincipal: "numeric_mm1cz0x0",
  } as const,
} as const;

/** Contracts board - for interest rate and base index */
export const CONTRACTS_BOARD = {
  boardId: "5092167972",
  columns: {
    interestRatePercent: "numeric_mm1fn125",
    baseIndex: "numeric_mm1f17hf",
  } as const,
} as const;

export const ACTUAL_PAYMENTS = {
  boardId: "5092169396",
  columns: {
    name: "name",
    receiptAmount: "numeric_mm0tyhpc",
    document: "file_mm0tcpmv",
    receiptType: "dropdown_mm0tv7z7",
    receiptDate: "date_mm0tny6b",
    notes: "text_mm0tyq8q",
    contracts: "board_relation_mm0t5e32",
    contractId: "text_mm18ghg5",
    receiptClearanceStatus: "color_mm14hrv2",
    amountForInterest: "numeric_mm1421wt",
    amountForIndexLinkage: "numeric_mm14ep9e",
    amountForPrincipal: "numeric_mm14bdn5",
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
