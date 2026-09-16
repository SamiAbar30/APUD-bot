/**
 * Deterministic text normalisation shared by the PDF auditor, the geography normaliser and
 * the identity parser. No locale-dependent behaviour, no randomness.
 */

/** Removes diacritics (NFD decomposition + combining-mark strip). Keeps `ñ` as `n`. */
export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Lower-cases, strips diacritics, replaces every non-alphanumeric run with a single space
 * and trims. Suitable for keyword matching (`"Allanamiento,"` -> `"allanamiento"`).
 */
export function normalizeForMatch(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Collapses whitespace runs to a single space and trims. Preserves case and accents. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Tokenises a normalised string into non-empty words. */
export function tokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t.length > 0);
}

/**
 * Returns a short context window around `index` (in `text`), collapsed to one line.
 * Used for evidence snippets; callers must treat snippets as personal data.
 */
export function snippetAround(text: string, index: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return collapseWhitespace(text.slice(start, end));
}
