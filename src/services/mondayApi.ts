/**
 * Monday.com GraphQL API client.
 * Uses MONDAY_API_TOKEN from environment.
 */

import { logger } from '../logger';

const API_URL = 'https://api.monday.com/v2';

export interface MondayApiResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
  account_id?: number;
}

export async function mondayQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not set');
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as MondayApiResponse<T>;
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    logger.warn('Monday API errors:', json.errors);
    throw new Error(`Monday API error: ${msg}`);
  }
  if (!json.data) {
    throw new Error('Monday API returned no data');
  }
  return json.data as T;
}
