export function capitalize(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
