/**
 * Truncate text to at most maxWords words.
 * Words are split on runs of whitespace; output is joined by single spaces.
 * If truncated, a single "…" (U+2026) is appended with no preceding space.
 * @param {string} text
 * @param {number} maxWords positive integer
 * @returns {string}
 */
export function truncateWords(text, maxWords) {
  if (typeof text !== 'string') {
    throw new TypeError('truncateWords expects a string');
  }
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new RangeError('maxWords must be a positive integer');
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return words.slice(0, maxWords).join(' ') + '…';
}
