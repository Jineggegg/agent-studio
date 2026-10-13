/**
 * The named duotone tints. Each has a soft plate colour and a strong glyph
 * colour, defined for both themes in styles/tokens.css and selected with a
 * `data-tint` attribute. "blue" is the server's default for a new project.
 */
export const TINTS = ['blue', 'sky', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple', 'slate'] as const;
export type Tint = (typeof TINTS)[number];

export function isTint(value: unknown): value is Tint {
  return typeof value === 'string' && (TINTS as readonly string[]).includes(value);
}

/** A stored colour name, or the default when it is not one of ours. */
export function toTint(value: unknown, fallback: Tint = 'blue'): Tint {
  return isTint(value) ? value : fallback;
}

/** A stable tint for a piece of text (a username, say), so the same name always gets the same colour. */
export function tintFor(text: string): Tint {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return TINTS[hash % TINTS.length]!;
}
