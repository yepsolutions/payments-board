/**
 * Israeli CBS (Central Bureau of Statistics) API client for price indices.
 * Fetches Construction Input Price Index and Consumer Price Index.
 *
 * CBS API: https://api.cbs.gov.il/index/
 * User-Agent header is mandatory for CBS requests.
 */

import { logger } from '../logger';

const CBS_BASE = process.env.CBS_API_BASE ?? 'https://api.cbs.gov.il';
const USER_AGENT = 'PaymentsBoard/1.0 (https://github.com)';

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface IndexRecord {
  period: string; // YYYY-MM
  value: number;
  month: number;
  year: number;
}

export interface FetchIndexResult {
  success: boolean;
  indexName: string;
  latest?: IndexRecord;
  error?: string;
  rawResponse?: string;
}

/** מדד מחירי תשומה בבנייה למגורים - כללי (CBS series 200010) */
const CONSTRUCTION_INDEX_ID = 200010;
const CONSTRUCTION_INDEX_NAME = 'מדד מחירי תשומה בבנייה למגורים - כללי';

/** CBS index codes from catalog tree */
export const CBS_INDEX_CODES = {
  CONSTRUCTION_INPUT: CONSTRUCTION_INDEX_ID,
  CONSUMER_PRICE: 120010, // מדד המחירים לצרכן - כללי
} as const;

/** Value must use base 2011 יולי (≈140.5), NOT base 2025 יולי (≈101.3). */
const BASE_2011_JULY = '2011 יולי';

/**
 * Fetch latest מדד מחירי תשומה בבנייה למגורים - כללי from CBS (series 200010).
 * Returns value with base 2011 יולי.
 */
export async function getLatestConstructionIndex(): Promise<FetchIndexResult> {
  const override = getOverride(CONSTRUCTION_INDEX_ID);
  if (override) {
    logger.info('Using CBS index override', { indexName: CONSTRUCTION_INDEX_NAME, override });
    return { success: true, indexName: CONSTRUCTION_INDEX_NAME, latest: override };
  }

  try {
    const res = await fetch(
      `${CBS_BASE}/index/data/price?id=${CONSTRUCTION_INDEX_ID}&format=json&download=false&last=6&coef=true`,
      { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) }
    );
    const data = (await res.json()) as Record<string, unknown>;

    const records = (data.month as Array<Record<string, unknown>>)?.[0]?.date as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(records) || records.length === 0) {
      return {
        success: false,
        indexName: CONSTRUCTION_INDEX_NAME,
        error: 'No records in CBS response',
      };
    }

    const latest = records[0] as Record<string, unknown> | undefined;
    if (!latest) {
      return {
        success: false,
        indexName: CONSTRUCTION_INDEX_NAME,
        error: 'No latest record',
      };
    }

    // API returns multiple index_base; explicitly select base="2011 יולי" (value ≈140.5).
    const indexBaseArr = (latest.index_base ?? latest.prevBase) as
      | Array<{ base?: string; baseDesc?: string; value?: number }>
      | undefined;
    const base2011 = indexBaseArr?.find(
      (b) => (b.base ?? b.baseDesc) === BASE_2011_JULY
    );
    if (!base2011 || typeof base2011.value !== 'number') {
      return {
        success: false,
        indexName: CONSTRUCTION_INDEX_NAME,
        error: `index_base with base="${BASE_2011_JULY}" not found in CBS response`,
      };
    }
    const value = base2011.value;
    const year = latest.year as number | undefined;
    const month = latest.month as number | undefined;
    const periodStr = String(latest.period ?? '');

    const period = periodStr.includes('-')
      ? periodStr
      : year != null && month != null
        ? `${String(month).padStart(2, '0')}-${year}`
        : '';

    if (isNaN(value) || (!period && (year == null || month == null))) {
      return {
        success: false,
        indexName: CONSTRUCTION_INDEX_NAME,
        error: 'Could not parse period or value from latest record',
      };
    }

    const indexRecord: IndexRecord = {
      period: period || `${String(month ?? 0).padStart(2, '0')}-${year ?? 0}`,
      value: roundTo2(value),
      month: month ?? 0,
      year: year ?? 0,
    };

    logger.info('Construction Input Index fetched', { latest: indexRecord });
    return { success: true, indexName: CONSTRUCTION_INDEX_NAME, latest: indexRecord };
  } catch (err) {
    logger.warn('Construction Input fetch failed', { err });
    return {
      success: false,
      indexName: CONSTRUCTION_INDEX_NAME,
      error: err instanceof Error ? err.message : 'Fetch failed',
    };
  }
}

/**
 * Extract from CBS price API format: { month: [{ date: [{ year, month, currBase: { value } }] }] }
 * Returns the index value for the latest month (sorts by period descending).
 */
function extractFromCbsPriceFormat(data: Record<string, unknown>): IndexRecord | null {
  const monthArr = data.month as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(monthArr) || monthArr.length === 0) return null;
  const dates = monthArr[0]?.date as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(dates) || dates.length === 0) return null;

  const records: IndexRecord[] = [];
  for (const d of dates) {
    const currBase = d?.currBase as { value?: number } | undefined;
    const year = d?.year as number | undefined;
    const month = d?.month as number | undefined;
    if (currBase?.value != null && year != null && month != null) {
      records.push({
        period: `${String(month).padStart(2, '0')}-${year}`,
        value: roundTo2(currBase.value),
        month,
        year,
      });
    }
  }
  if (records.length === 0) return null;
  records.sort((a, b) => b.period.localeCompare(a.period));
  return records[0];
}

/**
 * Extract the latest index value from CBS API response.
 * Handles various response structures (array of {Time, Value}, {data: [...]}, CBS price format, etc.)
 */
export function extractLatestIndex(
  data: unknown,
  indexName: string
): IndexRecord | null {
  if (!data || typeof data !== 'object') return null;

  const cbsPrice = extractFromCbsPriceFormat(data as Record<string, unknown>);
  if (cbsPrice) return cbsPrice;

  const arr = Array.isArray(data)
    ? data
    : (data as Record<string, unknown>).data ?? (data as Record<string, unknown>).month ?? (data as Record<string, unknown>).value;

  if (!Array.isArray(arr) || arr.length === 0) {
    const entries = Object.entries(data as Record<string, unknown>);
    const timeKey = entries.find(([k]) => /time|period|date|month/i.test(k))?.[0];
    const valueKey = entries.find(([k]) => /value|val|index|madad/i.test(k))?.[0];
    if (timeKey && valueKey) {
      const time = (data as Record<string, unknown>)[timeKey];
      const value = (data as Record<string, unknown>)[valueKey];
      const parsed = parsePeriodAndValue(time, value);
      if (parsed) return parsed;
    }
    return null;
  }

  const records: Array<{ period: string; value: number }> = [];
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const period = String(obj.Time ?? obj.time ?? obj.Period ?? obj.period ?? obj.Date ?? obj.date ?? obj.month ?? '');
      const value = parseFloat(String(obj.Value ?? obj.value ?? obj.Index ?? obj.index ?? obj.val ?? 0));
      if (period && !isNaN(value)) {
        const [y, m] = parsePeriodString(period);
        if (y && m) records.push({ period: `${String(m).padStart(2, '0')}-${y}`, value });
      }
    }
  }

  if (records.length === 0) return null;
  records.sort((a, b) => b.period.localeCompare(a.period));
  const latest = records[0];
  const [year, month] = latest.period.split('-').map(Number);
  return {
    period: latest.period,
    value: roundTo2(latest.value),
    month,
    year,
  };
}

function parsePeriodString(s: string): [number | null, number | null] {
  const str = String(s).trim();
  const m = str.match(/(\d{4})-(\d{1,2})/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  const m2 = str.match(/(\d{1,2})\/(\d{4})/);
  if (m2) return [parseInt(m2[2], 10), parseInt(m2[1], 10)];
  const m3 = str.match(/(\d{4})(\d{2})/);
  if (m3) return [parseInt(m3[1], 10), parseInt(m3[2], 10)];
  return [null, null];
}

function parsePeriodAndValue(time: unknown, value: unknown): IndexRecord | null {
  const [year, month] = parsePeriodString(String(time ?? ''));
  const val = parseFloat(String(value ?? 0));
  if (year && month && !isNaN(val)) {
    return {
      period: `${String(month).padStart(2, '0')}-${year}`,
      value: roundTo2(val),
      month,
      year,
    };
  }
  return null;
}

/**
 * Check for override from env (for testing when CBS API is unavailable).
 * CBS_INDEX_OVERRIDE='{"120010":{"period":"01-2026","value":106},"200010":{"period":"01-2026","value":140.5031}}'
 */
function getOverride(codeId: number): IndexRecord | null {
  const raw = process.env.CBS_INDEX_OVERRIDE;
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, { period?: string; value?: number }>;
    const key = String(codeId);
    const v = obj[key];
    if (v?.period && typeof v.value === 'number') {
      const [mm, yyyy] = v.period.split('-').map(Number);
      return { period: v.period, value: roundTo2(v.value), month: mm, year: yyyy };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Fetch latest index value from CBS API.
 * Tries multiple URL patterns as CBS API structure may vary.
 */
export async function fetchCbsIndex(
  codeId: number,
  indexName: string
): Promise<FetchIndexResult> {
  const override = getOverride(codeId);
  if (override) {
    logger.info('Using CBS index override', { indexName, override });
    return { success: true, indexName, latest: override };
  }

  const urls = [
    `${CBS_BASE}/index/data/price?id=${codeId}&format=json&download=false&last=6`,
    `${CBS_BASE}/index/data/${codeId}?format=json&download=false`,
    `${CBS_BASE}/index/data/${codeId}?format=json`,
    `${CBS_BASE}/series/data/${codeId}?format=json&last=24`,
  ];

  for (const url of urls) {
    try {
      logger.info('Fetching CBS index', { indexName, codeId, url });
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });

      const text = await res.text();
      logger.info('CBS API response', {
        indexName,
        status: res.status,
        length: text.length,
        preview: text.slice(0, 300),
      });

      if (!res.ok) continue;

      if (text.includes('Oops') || text.includes('not found') || text.includes('<!DOCTYPE')) {
        continue;
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }

      const latest = extractLatestIndex(data, indexName);
      if (latest) {
        logger.info('Parsed latest index', { indexName, latest });
        return { success: true, indexName, latest };
      }
    } catch (err) {
      logger.warn('CBS fetch attempt failed', { indexName, url, err });
    }
  }

  return {
    success: false,
    indexName,
    error: `Could not fetch latest ${indexName} from CBS API`,
    rawResponse: 'All URL patterns returned no valid data',
  };
}

