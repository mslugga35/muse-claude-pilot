/**
 * Turn a title into a URL/branch-safe slug.
 * Lowercase, ASCII letters/digits only, words joined by single hyphens, max 40 chars.
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string');
  }
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
