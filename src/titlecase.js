/**
 * Title-case a string: each whitespace-separated word gets an uppercase first letter.
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
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
