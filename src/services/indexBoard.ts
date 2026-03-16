/**
 * Creates index items in Monday board from CBS price index data.
 */

import { mondayQuery } from './mondayApi';
import { logger } from '../logger';
import { INDEX_BOARD } from '../config/config';
import type { IndexRecord } from './cbsApi';
import { fetchConstructionIndexHistory } from './cbsApi';

export interface CreateIndexItemResult {
  success: boolean;
  itemId?: string;
  error?: string;
}

/**
 * Create a Monday item for an index value.
 */
export async function createIndexItem(
  groupId: string,
  record: IndexRecord,
  updateDate: string
): Promise<CreateIndexItemResult> {
  const itemName = record.period; // MM-YYYY format
  const col = INDEX_BOARD.columns;

  const columnValues: Record<string, string | Record<string, string>> = {
    [col.indexValue]: Number(record.value).toFixed(2),
    [col.updateDate]: { date: updateDate },
  };

  const columnValuesJson = JSON.stringify(columnValues);

  const mutation = `
    mutation CreateIndexItem($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `;

  try {
    const data = await mondayQuery<{
      create_item: { id: string; name: string };
    }>(mutation, {
      boardId: INDEX_BOARD.boardId,
      groupId,
      itemName,
      columnValues: columnValuesJson,
    });

    const item = data.create_item;
    return { success: true, itemId: item.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Monday create_item failed', { groupId, itemName, error: msg });
    return { success: false, error: msg };
  }
}

export interface FillConstructionIndexResult {
  success: boolean;
  created: number;
  updated: number;
  error?: string;
}

/**
 * Fill Construction Input Index data into Monday board (group "topics").
 * Fetches CBS series 200010 from 01-2020, creates or updates items.
 */
export async function fillConstructionIndex(): Promise<FillConstructionIndexResult> {
  const boardId = INDEX_BOARD.boardId;
  const groupId = INDEX_BOARD.groups.constructionInput;
  const col = INDEX_BOARD.columns;
  const updateDate = new Date().toISOString().slice(0, 10);

  const cbsResult = await fetchConstructionIndexHistory();
  if (!cbsResult.success || !cbsResult.records?.length) {
    return {
      success: false,
      created: 0,
      updated: 0,
      error: cbsResult.error ?? 'No CBS data',
    };
  }

  const existingItems = new Map<string, string>();
  const groupsQuery = `
    query GetConstructionGroupItems($boardId: ID!) {
      boards(ids: [$boardId]) {
        groups(ids: ["${groupId}"]) {
          id
          items_page(limit: 500) {
            cursor
            items { id name }
          }
        }
      }
    }
  `;

  try {
    const groupsRes = await mondayQuery<{
      boards: Array<{ groups: Array<{ items_page: { cursor: string | null; items: Array<{ id: string; name: string }> } }> }>;
    }>(groupsQuery, { boardId });

    const group = groupsRes.boards?.[0]?.groups?.[0];
    if (group) {
      for (const item of group.items_page.items) {
        existingItems.set(item.name.trim(), item.id);
      }
      let pageCursor = group.items_page.cursor;
      while (pageCursor) {
        const nextRes = await mondayQuery<{
          next_items_page: { cursor: string | null; items: Array<{ id: string; name: string }> };
        }>(
          `query($cursor: String!) { next_items_page(cursor: $cursor, limit: 500) { cursor items { id name } } }`,
          { cursor: pageCursor }
        );
        const nextPage = nextRes.next_items_page;
        pageCursor = nextPage?.cursor ?? null;
        for (const item of nextPage?.items ?? []) {
          existingItems.set(item.name.trim(), item.id);
        }
      }
    }
  } catch (err) {
    logger.warn('Could not fetch existing items from group, will create all', { groupId, err });
  }

  let created = 0;
  let updated = 0;

  for (const record of cbsResult.records) {
    const columnValues: Record<string, string | Record<string, string>> = {
      [col.indexValue]: Number(record.value).toFixed(2),
      [col.updateDate]: { date: updateDate },
    };
    const columnValuesJson = JSON.stringify(columnValues);

    const existingId = existingItems.get(record.name);
    if (existingId) {
      try {
        const mutation = `
          mutation UpdateItem($itemId: ID!, $boardId: ID!, $columnValues: JSON!) {
            change_multiple_column_values(item_id: $itemId, board_id: $boardId, column_values: $columnValues) {
              id
            }
          }
        `;
        await mondayQuery(mutation, {
          itemId: parseInt(existingId, 10),
          boardId,
          columnValues: columnValuesJson,
        });
        updated++;
      } catch (err) {
        logger.warn('Monday update failed', { itemId: existingId, name: record.name, err });
      }
    } else {
      const result = await createIndexItemWithName(groupId, record.name, columnValues);
      if (result.success) {
        created++;
        if (result.itemId) existingItems.set(record.name, result.itemId);
      }
    }
  }

  logger.info('fill-construction-index completed', { created, updated, total: cbsResult.records.length });
  return { success: true, created, updated };
}

async function createIndexItemWithName(
  groupId: string,
  itemName: string,
  columnValues: Record<string, string | Record<string, string>>
): Promise<CreateIndexItemResult> {
  const columnValuesJson = JSON.stringify(columnValues);
  const mutation = `
    mutation CreateIndexItem($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `;
  try {
    const data = await mondayQuery<{ create_item: { id: string; name: string } }>(mutation, {
      boardId: INDEX_BOARD.boardId,
      groupId,
      itemName,
      columnValues: columnValuesJson,
    });
    return { success: true, itemId: data.create_item.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Monday create_item failed', { groupId, itemName, error: msg });
    return { success: false, error: msg };
  }
}
