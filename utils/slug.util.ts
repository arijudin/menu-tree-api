/**
 * Return true if string is empty or just filled by '-' (ie. "-" or "---")
 */

export function isEmptyOrHyphens(s: string | undefined | null): boolean {
  if (!s) return true;
  return !s.replace(/-/g, '').trim();
}

/**
 * Slug unicode-friendly:
 * - NFKC normalize
 * - whitespace -> '-'
 * - keep letters/numbers unicode + [-_.~]
 * - collapse '-' in a row
 * - trim '-' at beginning/end
 */
export function unicodeSlug(input: string): string {
  if (!input) return '';
  const normalized = input.normalize('NFKC').trim();
  let s = normalized.replace(/\s+/g, '-');
  s = s.replace(/[^\p{L}\p{N}\-_.~]/gu, '');
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  return s;
}
