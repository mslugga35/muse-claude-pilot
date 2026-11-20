export function wordCount(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}
