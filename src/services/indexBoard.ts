/**
 * Creates index items in Monday board from CBS price index data.
 */

import { mondayQuery } from './mondayApi';
import { logger } from '../logger';
import { INDEX_BOARD } from '../config/config';
import type { IndexRecord } from './cbsApi';

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
    [col.indexValue]: String(record.value),
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
    logger.info('Creating Monday index item', {
      boardId: INDEX_BOARD.boardId,
      groupId,
      itemName,
      columnValues,
    });

    const data = await mondayQuery<{
      create_item: { id: string; name: string };
    }>(mutation, {
      boardId: INDEX_BOARD.boardId,
      groupId,
      itemName,
      columnValues: columnValuesJson,
    });

    const item = data.create_item;
    logger.info('Monday create_item result', { itemId: item.id, name: item.name });

    return { success: true, itemId: item.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Monday create_item failed', { groupId, itemName, error: msg });
    return { success: false, error: msg };
  }
}
