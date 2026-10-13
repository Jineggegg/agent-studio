import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

export interface BackControl {
  /** The parent's name: the control says where it goes. */
  label: string;
  onPress: () => void;
  /** When the visible label is not enough ("Home" → "Back to Home"). */
  accessibleLabel?: string;
}

export interface NavigationBarProps {
  title: ReactNode;
  /** A second, quieter line under the title (a conversation's project, say). */
  subtitle?: ReactNode;
  /** The back control. Omit on a root screen. */
  back?: BackControl | null;
  /** Replaces the back control (a "Cancel" button, a menu). */
  leading?: ReactNode;
  /** Actions at the trailing edge — `IconButton`s or one plain `Button`. */
  trailing?: ReactNode;
  /** Content has scrolled under the bar: draw it as a material with a hairline. */
  raised?: boolean;
  /** The screen's large title is still visible, so the bar's own title stays hidden. */
  titleHidden?: boolean;
  /** Render the title as the page's `h1` (when there is no large title to be it). */
  titleIsHeading?: boolean;
  className?: string;
}

/** The bar at the top of a screen: where you came from, where you are, what you can do. */
export function NavigationBar({ title, subtitle, back, leading, trailing, raised, titleHidden, titleIsHeading, className }: NavigationBarProps) {
  const Title = titleIsHeading ? 'h1' : 'div';
  return (
    <header className={className ? `ui-navbar ${className}` : 'ui-navbar'} data-raised={raised || undefined} data-title-hidden={titleHidden || undefined}>
      <div className="ui-navbar__inner">
        <div className="ui-navbar__leading">
          {leading ??
            (back && (
              <button type="button" className="ui-navbar__back" onClick={back.onPress} aria-label={back.accessibleLabel ?? back.label}>
                <ChevronLeft size={24} strokeWidth={2.2} aria-hidden="true" />
                <span>{back.label}</span>
              </button>
            ))}
        </div>
        <Title className="ui-navbar__title" aria-hidden={titleHidden && !titleIsHeading ? true : undefined}>
          {title}
          {subtitle && <span className="ui-navbar__subtitle">{subtitle}</span>}
        </Title>
        <div className="ui-navbar__trailing">{trailing}</div>
      </div>
    </header>
  );
}

export interface LargeTitleProps {
  children: ReactNode;
  /** A line under the title. */
  caption?: ReactNode;
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * The big heading a screen starts with. It scrolls away with the content;
 * `Screen` then shows the bar's own title in its place.
 */
export function LargeTitle({ children, caption, ref }: LargeTitleProps) {
  return (
    <div className="ui-large-title" ref={ref}>
      <h1>{children}</h1>
      {caption && <p>{caption}</p>}
    </div>
  );
}
