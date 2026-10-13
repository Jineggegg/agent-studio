import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { LargeTitle, NavigationBar } from '@/ui';
import { type ParentScreen, useBack } from './back';
import { announceFirstPaint } from './launch';
import { useScrollRestoration } from './scroll';
import { useDocumentTitle } from './title';

export interface ScreenProps {
  /** Shown as the large title, in the bar once that has scrolled away, and in the tab title. */
  title: string;
  /** A line under the large title. */
  caption?: ReactNode;
  /** A second line under the bar's title. */
  subtitle?: ReactNode;
  /**
   * Where back goes when nothing is behind this screen in history, and what
   * that place is called. Default: the home screen. Pass null for a root
   * screen that has no back control.
   */
  parent?: ParentScreen | null;
  /** Bar actions at the trailing edge. */
  actions?: ReactNode;
  /** Replaces the back control (a "Cancel" button, say). */
  leading?: ReactNode;
  /** Start with a large title that collapses into the bar on scroll. Default true. */
  largeTitle?: boolean;
  /** A row fixed under the bar and above the scrolling content — sibling tabs, a search field. */
  toolbar?: ReactNode;
  /** A bar docked to the bottom edge. It stays above the soft keyboard. */
  footer?: ReactNode;
  /** `reading` (default) keeps lines comfortable; `wide` for dashboards; `full` runs edge to edge. */
  width?: 'reading' | 'wide' | 'full';
  /** Distinguishes this screen's scroll area when one history entry shows several. */
  scrollId?: string;
  /** Gives access to the scroll container. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  className?: string;
}

/**
 * The scaffold every screen is built on: navigation bar with a back control
 * that names where it goes, a large title that collapses on scroll, one
 * scroll area whose position is restored on return, safe-area padding, the
 * tab title — and the same "back" for the control, the keyboard and the edge swipe.
 */
export function Screen({
  title,
  caption,
  subtitle,
  parent,
  actions,
  leading,
  largeTitle = true,
  toolbar,
  footer,
  width = 'reading',
  scrollId,
  scrollRef,
  children,
  className,
}: ScreenProps) {
  const t = useT();
  const ownRef = useRef<HTMLDivElement>(null);
  const scroller = scrollRef ?? ownRef;
  const heading = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [headingGone, setHeadingGone] = useState(false);

  const resolvedParent = parent === undefined ? { to: '/', label: t('nav.home') } : parent;
  const back = useBack(resolvedParent);
  useDocumentTitle(title);
  useScrollRestoration(scroller, scrollId);
  useEffect(() => announceFirstPaint(), []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = element.scrollTop;
      setScrolled(top > 2);
      const height = heading.current?.offsetHeight ?? 0;
      setHeadingGone(height > 0 ? top > height - 14 : true);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      element.removeEventListener('scroll', onScroll);
    };
  }, [scroller, largeTitle]);

  return (
    <div className={className ? `screen ${className}` : 'screen'} data-width={width} data-toolbar={toolbar ? '' : undefined}>
      <NavigationBar
        title={title}
        subtitle={subtitle}
        back={back ? { label: back.label, accessibleLabel: back.accessibleLabel, onPress: back.go } : null}
        leading={leading}
        trailing={actions}
        raised={scrolled || !!toolbar}
        titleHidden={largeTitle && !headingGone}
        titleIsHeading={!largeTitle}
      />
      {toolbar && <div className="screen__toolbar">{toolbar}</div>}
      <div ref={scroller} className="screen__scroll u-scroll">
        {largeTitle && (
          <div className="screen__title">
            <LargeTitle ref={heading} caption={caption}>
              {title}
            </LargeTitle>
          </div>
        )}
        <div className="screen__content">{children}</div>
      </div>
      {footer && <div className="screen__footer">{footer}</div>}
    </div>
  );
}
