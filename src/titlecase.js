/**
 * Title-case a string: first letter of each whitespace-separated word uppercased, the rest lowercased.
 * @param {string} text
 * @returns {string}
 */
export function titleCase(text) {
  if (typeof text !== 'string') {
    throw new TypeError('titleCase expects a string');
  }
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
