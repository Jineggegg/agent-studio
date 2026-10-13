import type { CSSProperties, ReactNode } from 'react';
import { type Tint, tintFor } from './tints';

export interface AvatarProps {
  /** The person's name; its first letter is shown and it picks the colour. */
  name: string;
  /** Diameter in CSS px. Default 40. */
  size?: number;
  tint?: Tint;
  className?: string;
}

/** A person, as an initial on a tinted disc. Decorative: put the name next to it. */
export function Avatar({ name, size = 40, tint, className }: AvatarProps) {
  const initial = [...name.trim()][0] ?? '?';
  return (
    <span
      className={className ? `ui-avatar ${className}` : 'ui-avatar'}
      data-tint={tint ?? tintFor(name)}
      style={{ '--avatar-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export interface GlyphProps {
  /** An icon element, sized to about half of `size`. */
  icon: ReactNode;
  tint?: Tint | undefined;
  /** Side length in CSS px. Default 30. */
  size?: number;
  className?: string;
}

/** An icon on a duotone plate: the leading mark of a settings row, a tile, a picker option. */
export function Glyph({ icon, tint, size = 30, className }: GlyphProps) {
  return (
    <span className={className ? `ui-glyph ${className}` : 'ui-glyph'} data-tint={tint} style={{ '--glyph-size': `${size}px` } as CSSProperties} aria-hidden="true">
      {icon}
    </span>
  );
}
