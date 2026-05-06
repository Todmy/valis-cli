/**
 * Token budget heuristic + ranked-corpus slot fill.
 *
 * Per research.md R-02: 4-chars-per-token approximation; conservative
 * over-count for Cyrillic/CJK. Slot-fill drops items past the budget;
 * never truncates mid-item.
 */

const CHARS_PER_TOKEN_DEFAULT = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative: count code units (so Cyrillic / CJK over-counts vs grapheme — which is what we want
  // for budget enforcement; better to under-fill than overflow context).
  return Math.ceil(text.length / CHARS_PER_TOKEN_DEFAULT);
}

export interface SlotFillItem {
  /** Serialized representation; what gets concatenated into the block. */
  text: string;
}

export interface SlotFillResult<T extends SlotFillItem> {
  selected: T[];
  selectedTokens: number;
  droppedCount: number;
}

/**
 * Fill a token-bounded slot from a ranked-by-priority list.
 *
 * Walks `items` in priority order, taking each that still fits. An item
 * that would push the running sum over `budgetTokens` is dropped; the
 * walk continues with the next candidate so a single over-budget item
 * doesn't starve later items that would still fit. We never truncate
 * an item mid-text.
 *
 * `maxItems` is an additional cap (defaults to Infinity).
 */
export function fillSlot<T extends SlotFillItem>(
  items: readonly T[],
  budgetTokens: number,
  maxItems: number = Number.POSITIVE_INFINITY,
): SlotFillResult<T> {
  const selected: T[] = [];
  let selectedTokens = 0;

  for (const item of items) {
    if (selected.length >= maxItems) break;
    const cost = estimateTokens(item.text);
    if (selectedTokens + cost > budgetTokens) continue;
    selected.push(item);
    selectedTokens += cost;
  }

  return {
    selected,
    selectedTokens,
    droppedCount: items.length - selected.length,
  };
}
