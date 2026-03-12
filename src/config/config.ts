export const CONTRACTUAL_PAYMENTS = {
  boardId: "5092167973",
  items: {
    paymentDue: "numeric_mm0tv8dx",
    indexationPaymentDue: "numeric_mm14mht9",
    interestPaymentDue: "numeric_mm184vaa",
    interestPercent: "numeric_mm19xy22",
    /** Contract link column - links to the same contract as Actual Payments */
    contractLink: "board_relation_mm0tcdy3",
  } as const,
  subitems: {
    boardId: "5092168551",
    name: "name",
    actualReceipt: "numeric_mm1bp0ht",
    principal: "formula_mm1bwstj",
    interest: "numeric_mm1bkqds",
    indexLinkage: "numeric_mm19panw",
    remainingInterest: "numeric_mm1cdy74",
    remainingIndexLinkage: "numeric_mm1cf2ws",
    remainingPrincipal: "numeric_mm1cz0x0",
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

export type ContractualPaymentsItemColumnKey = keyof typeof CONTRACTUAL_PAYMENTS.items;
export type ContractualPaymentsSubitemColumnKey = keyof typeof CONTRACTUAL_PAYMENTS.subitems;
export type ActualPaymentsColumnKey = keyof typeof ACTUAL_PAYMENTS.columns;
