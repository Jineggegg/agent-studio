import { Archive, Bell, FolderOpen, Globe, Inbox, Languages, Moon, Pencil, Pin, Plus, RefreshCw, Rocket, Settings, Sun, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ApiError } from '@/data/http';
import { applyLanguagePreference, useLanguage, useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { useKeyboard } from '@/platform/viewport';
import { applyThemePreference, useTheme } from '@/platform/theme';
import { Screen } from '@/shell/Screen';
import {
  ActivityMark,
  Avatar,
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  CountBadge,
  DelayedSkeleton,
  EmptyState,
  ErrorState,
  Form,
  Glyph,
  IconButton,
  List,
  ListRow,
  LoadingRow,
  LogoMark,
  MenuButton,
  NavigationBar,
  ProgressLine,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  SkeletonText,
  Spinner,
  StaleNotice,
  Switch,
  TINTS,
  Tabs,
  TextArea,
  TextField,
  confirm,
  progress,
  tabPanelProps,
  toast,
} from '@/ui';
import { Markdown } from '@/ui/markdown';
import './gallery.css';

/*
 * The component gallery: every component of the design system, in every
 * state, on one page. Development builds only (see main.tsx). Its text is
 * sample content for developers and is deliberately not translated; flip the
 * theme and language with the buttons in the bar to check a component in both.
 */

const SAMPLE_MARKDOWN = `## Markdown, rendered safely

Text with **bold**, *emphasis*, ~~strikethrough~~, \`inline code\` and a [link](https://example.com/docs) that opens in a new tab.
A [javascript link](javascript:alert(1)) is not a link at all, and raw HTML such as <script>alert(1)</script><b>this</b> is dropped.

- [x] task lists
- [ ] are pictures of a list, not controls

1. Ordered
2. Lists

> A quotation, set apart.

| Layout class | Width |
| --- | --- |
| phone | ≤ 699 px |
| tablet | 700–1023 px |
| wide | ≥ 1024 px |

\`\`\`ts
// Code blocks are highlighted and have a copy button.
export function layoutClassForWidth(width: number): LayoutClass {
  if (width <= 699) return 'phone';
  return width <= 1023 ? 'tablet' : 'wide';
}
\`\`\`

A remote image is not fetched until tapped: ![A diagram](https://example.com/diagram.png)
`;

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="gallery__section" aria-label={title}>
      <h2 className="gallery__heading">{title}</h2>
      {note && <p className="gallery__note">{note}</p>}
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="gallery__row">
      {label && <span className="gallery__label">{label}</span>}
      <div className="gallery__items">{children}</div>
    </div>
  );
}

const COLOR_TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-surface-alt',
  '--color-sunken',
  '--color-fill',
  '--color-text',
  '--color-text-secondary',
  '--color-text-tertiary',
  '--color-separator-strong',
  '--color-accent',
  '--color-accent-soft',
  '--color-danger',
  '--color-positive',
  '--color-warning',
  '--color-info',
];

const TYPE_ROLES = ['text-display', 'text-title-1', 'text-title-2', 'text-title-3', 'text-headline', 'text-body', 'text-callout', 'text-footnote', 'text-caption'];

export default function ComponentGallery() {
  const t = useT();
  const theme = useTheme();
  const language = useLanguage();
  const layout = useLayoutClass();
  const keyboard = useKeyboard();

  const [text, setText] = useState('');
  const [secret, setSecret] = useState('correct horse battery');
  const [notes, setNotes] = useState('');
  const [on, setOn] = useState(true);
  const [checked, setChecked] = useState({ read: true, write: false });
  const [segment, setSegment] = useState<'day' | 'week' | 'month'>('week');
  const [choice, setChoice] = useState<'claude' | 'codex' | 'none'>('claude');
  const [tab, setTab] = useState<'files' | 'terminal' | 'git' | 'preview'>('files');
  const [sheet, setSheet] = useState<'sm' | 'md' | 'lg' | 'fill' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [determinate, setDeterminate] = useState(0.35);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const rowActions = [
    { id: 'pin', label: 'Pin', icon: <Pin size={18} />, tone: 'accent' as const, onSelect: () => toast.info('Pinned') },
    { id: 'archive', label: 'Archive', icon: <Archive size={18} />, tone: 'warning' as const, onSelect: () => toast.show({ title: 'Archived', action: { label: 'Undo', onSelect: () => toast.success('Restored') } }) },
    { id: 'delete', label: 'Delete', icon: <Trash2 size={18} />, tone: 'danger' as const, onSelect: () => toast.error('Deleted (not really)') },
  ];

  return (
    <Screen
      title={t('dev.gallery.title')}
      caption={`layout: ${layout} · theme: ${theme} · language: ${language} · keyboard: ${keyboard.open ? `open (${keyboard.inset}px)` : 'closed'}`}
      width="wide"
      actions={
        <>
          <IconButton label="Switch language" icon={<Languages size={21} />} onClick={() => applyLanguagePreference(language === 'en' ? 'zh-CN' : 'en')} />
          <IconButton label="Switch theme" icon={theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />} onClick={() => applyThemePreference(theme === 'dark' ? 'light' : 'dark', { crossFade: true })} />
        </>
      }
    >
      <div className="gallery">
        <Section title="Colour" note="Semantic tokens. Components never use raw values; the theme redefines these.">
          <div className="gallery__swatches">
            {COLOR_TOKENS.map((token) => (
              <div key={token} className="gallery__swatch">
                <span style={{ background: `var(${token})` }} />
                <code>{token}</code>
              </div>
            ))}
          </div>
          <Row label="Tints">
            {TINTS.map((tint) => (
              <Glyph key={tint} tint={tint} size={40} icon={<FolderOpen size={22} />} />
            ))}
          </Row>
        </Section>

        <Section title="Type">
          {TYPE_ROLES.map((role) => (
            <p key={role} className={role}>
              {role.replace('text-', '')} — The quick brown fox · 敏捷的棕色狐狸
            </p>
          ))}
        </Section>

        <Section title="Button" note="One primary per view. Destructive is never the loudest. Small is drawn small but still 44 px to the finger.">
          <Row label="Variants">
            <Button variant="primary">Primary</Button>
            <Button variant="tinted">Tinted</Button>
            <Button variant="neutral">Neutral</Button>
            <Button variant="plain">Plain</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="plain-danger">Plain danger</Button>
          </Row>
          <Row label="Sizes">
            <Button variant="primary" size="sm">
              Small
            </Button>
            <Button variant="primary">Medium</Button>
            <Button variant="primary" size="lg">
              Large
            </Button>
          </Row>
          <Row label="States">
            <Button variant="primary" icon={<Plus size={18} />}>
              With icon
            </Button>
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Button variant="primary" loading>
              Loading
            </Button>
            <Button variant="tinted" loading loadingLabel="Saving…">
              Save
            </Button>
          </Row>
          <Button variant="primary" size="lg" block>
            Block, large
          </Button>
        </Section>

        <Section title="IconButton">
          <Row>
            <IconButton label="Settings" icon={<Settings size={22} />} />
            <IconButton label="Notifications" icon={<Bell size={22} />} variant="filled" />
            <IconButton label="Accent" icon={<Rocket size={22} />} tone="accent" />
            <IconButton label="Delete" icon={<Trash2 size={22} />} tone="danger" />
            <IconButton label="Refreshing" icon={<RefreshCw size={21} />} busy />
            <IconButton label="Disabled" icon={<Pencil size={22} />} disabled />
          </Row>
        </Section>

        <Section title="TextField and TextArea" note="16 px text (no iOS zoom). Enter during input-method composition never submits.">
          <Form
            className="gallery__form"
            onSubmit={() => {
              setSubmitted(text || '(empty)');
              toast.success(`Submitted: ${text || '(empty)'}`);
            }}
          >
            <TextField label="Name" value={text} onChange={setText} hint="Press Enter to submit — try it while composing Chinese." placeholder="Type here" />
            <TextField label="With an error" value={text} onChange={setText} error="That name is taken." />
            <TextField label="Password" type="password" value={secret} onChange={setSecret} autoComplete="off" />
            <TextField label="Path" mono optional value="~/projects/agent-studio" onChange={() => undefined} />
            <TextField label="Disabled" value="Cannot be changed" onChange={() => undefined} disabled />
            <TextArea label="Notes" optional value={notes} onChange={setNotes} autoGrow hint="Grows with its text up to eight lines." />
            <p className="text-footnote text-secondary">Last submitted: {submitted ?? 'nothing yet'}</p>
          </Form>
        </Section>

        <Section title="Switch, Checkbox, SegmentedControl, Select">
          <Row label="Switch">
            <Switch checked={on} onChange={setOn} label="Example" />
            <Switch checked={!on} onChange={(value) => setOn(!value)} label="Inverse" />
            <Switch checked onChange={() => undefined} disabled label="Disabled on" />
            <Switch checked={false} onChange={() => undefined} disabled label="Disabled off" />
          </Row>
          <div className="gallery__form">
            <Checkbox checked={checked.read} onChange={(read) => setChecked((current) => ({ ...current, read }))} label="Read" hint="See projects and conversations." />
            <Checkbox checked={checked.write} onChange={(write) => setChecked((current) => ({ ...current, write }))} label="Write" hint="Start work and change things." />
            <Checkbox checked onChange={() => undefined} label="Disabled" disabled />
            <SegmentedControl
              label="Range"
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ]}
            />
            <Select
              label="Default agent"
              value={choice}
              onChange={setChoice}
              block
              options={[
                { value: 'claude', label: 'Claude Code', hint: 'Signed in' },
                { value: 'codex', label: 'Codex', hint: 'Signed in' },
                { value: 'none', label: 'Ask every time' },
              ]}
            />
          </div>
          <Row label="Menu">
            <MenuButton
              label="More"
              variant="filled"
              align="start"
              items={[
                { id: 'rename', label: 'Rename', icon: <Pencil size={18} />, onSelect: () => toast.info('Rename') },
                { id: 'open', label: 'Open in new tab', icon: <Globe size={18} />, hint: 'Leaves the app', onSelect: () => toast.info('Open') },
                { id: 'separator', separator: true },
                { id: 'delete', label: 'Delete', icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => toast.error('Delete') },
              ]}
            />
            <span className="text-footnote text-secondary">A popover here on tablet and wide; a bottom sheet on a phone.</span>
          </Row>
        </Section>

        <Section title="List and ListRow" note="Slide a row towards the leading edge to reveal its actions; the “…” button offers the same without swiping.">
          <List header="Sessions" headerAction={<Button variant="plain" size="sm">Show all</Button>} footer="A footer explains what the rows above do.">
            <ListRow leading={<Glyph icon={<Inbox size={18} />} tint="red" />} title="Navigates" subtitle="Has a chevron, goes somewhere" value="3" to="/dev/components" />
            <ListRow leading={<Glyph icon={<Rocket size={18} />} tint="teal" />} title="Swipe me" subtitle="Pin · Archive · Delete" trailing={<ActivityMark kind="running" />} actions={rowActions} onPress={() => toast.info('Row pressed')} />
            <ListRow leading={<Glyph icon={<Bell size={18} />} tint="amber" />} title="With a switch" subtitle="The whole row is the label" control={<Switch checked={on} onChange={setOn} />} />
            <ListRow leading={<Glyph icon={<Settings size={18} />} tint="slate" />} title="Selected" value="Current" selected onPress={() => undefined} />
            <ListRow title="Static, no leading" value="Read-only value" />
            <ListRow title="Disabled" onPress={() => undefined} disabled />
            <ListRow title="Destructive" tone="danger" onPress={() => setConfirming(true)} />
          </List>
        </Section>

        <Section title="NavigationBar" note="Screens get this from <Screen>; shown here on its own.">
          <div className="gallery__frame">
            <NavigationBar title="Title" back={{ label: 'Projects', onPress: () => toast.info('Back') }} trailing={<IconButton label="Refresh" icon={<RefreshCw size={21} />} />} raised titleIsHeading={false} />
          </div>
          <div className="gallery__frame">
            <NavigationBar title="Conversation" subtitle="agent-studio" back={{ label: 'Home', accessibleLabel: 'Back to Home', onPress: () => toast.info('Back') }} raised={false} />
          </div>
        </Section>

        <Section title="Tabs">
          <Tabs
            label="Tools"
            idBase="gallery-tools"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'files', label: 'Files' },
              { value: 'terminal', label: 'Terminal', accessory: <ActivityMark kind="running" /> },
              { value: 'git', label: 'Git', accessory: <CountBadge count={3} label="3 changes" /> },
              { value: 'preview', label: 'Preview', disabled: true },
            ]}
          />
          <div {...tabPanelProps('gallery-tools', tab)} className="gallery__panel">
            Panel for “{tab}”.
          </div>
        </Section>

        <Section title="Sheet and ConfirmDialog" note="Bottom sheet with drag-to-dismiss on phone, centred dialog otherwise. Focus is trapped and returned; Escape and the backdrop close; no history entry.">
          <Row>
            <Button onClick={() => setSheet('sm')}>Small</Button>
            <Button onClick={() => setSheet('md')}>Medium</Button>
            <Button onClick={() => setSheet('lg')}>Large</Button>
            <Button onClick={() => setSheet('fill')}>Full height (phone)</Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Confirm dialog
            </Button>
            <Button
              onClick={() =>
                void confirm({ title: 'Reset the layout?', message: 'Order and folders return to their defaults on every device. Names are not affected.', confirmLabel: 'Reset', tone: 'danger' }).then((yes) =>
                  toast.info(yes ? 'Confirmed' : 'Cancelled'),
                )
              }
            >
              confirm() promise
            </Button>
          </Row>
          <Sheet
            open={sheet !== null}
            onClose={() => setSheet(null)}
            title="A sheet"
            size={sheet === 'fill' || sheet === null ? 'md' : sheet}
            fill={sheet === 'fill'}
            footer={
              <>
                <Button onClick={() => setSheet(null)}>Cancel</Button>
                <Button variant="primary" onClick={() => setSheet(null)}>
                  Done
                </Button>
              </>
            }
          >
            <div className="gallery__form">
              <p className="text-secondary">Tab stays inside. Try Escape, the backdrop, or — on a phone — dragging the handle down.</p>
              <TextField label="A field" value={text} onChange={setText} />
              <ListRow title="A switch inside" control={<Switch checked={on} onChange={setOn} />} />
              <Button onClick={() => setConfirming(true)}>Open a dialog on top</Button>
            </div>
          </Sheet>
          <ConfirmDialog
            open={confirming}
            title="Remove “agent-studio”?"
            message="The Studio forgets this project. The folder and its files are not touched."
            confirmLabel="Remove"
            tone="danger"
            onCancel={() => setConfirming(false)}
            onConfirm={async () => {
              await new Promise((resolve) => setTimeout(resolve, 900));
              setConfirming(false);
              toast.success('Removed (not really)');
            }}
          />
        </Section>

        <Section title="Toast" note="Plain 3 s · with an action or detail 6 s · warnings and errors 7 s · persistent until acted on.">
          <Row>
            <Button onClick={() => toast.info('Copied to clipboard')}>Info</Button>
            <Button onClick={() => toast.success('Project created')}>Success</Button>
            <Button onClick={() => toast.warning('Connection is slow')}>Warning</Button>
            <Button onClick={() => toast.error('Could not save', { detail: 'The server did not answer.' })}>Error</Button>
            <Button onClick={() => toast.show({ title: 'Session archived', action: { label: 'Undo', onSelect: () => toast.success('Restored') } })}>With Undo</Button>
            <Button onClick={() => toast.show({ id: 'gallery-update', title: 'Agent Studio was updated', detail: 'Refresh to use the new version.', duration: 'persistent', action: { label: 'Refresh', onSelect: () => undefined } })}>
              Persistent
            </Button>
          </Row>
        </Section>

        <Section title="Loading" note="Skeletons appear only after 140 ms. The progress line is for work the user started.">
          <Row>
            <Button onClick={() => setLoading((value) => !value)}>{loading ? 'Stop' : 'Show'} skeletons</Button>
            <Button
              onClick={() => {
                const done = progress.start();
                window.setTimeout(done, 2500);
              }}
            >
              Global progress line (2.5 s)
            </Button>
            <Spinner />
            <Spinner size={28} label="Working" />
          </Row>
          {loading && (
            <DelayedSkeleton label="Loading sample">
              <div className="gallery__skeleton">
                <Skeleton width={56} height={56} radius={16} />
                <div style={{ flex: 1 }}>
                  <SkeletonText lines={3} />
                </div>
              </div>
            </DelayedSkeleton>
          )}
          <LoadingRow label="Reading…" />
          <Row label="Determinate">
            <div style={{ flex: 1, minWidth: 160 }}>
              <ProgressLine inline active value={determinate} label="Build progress" />
            </div>
            <Button size="sm" onClick={() => setDeterminate((value) => (value >= 1 ? 0 : Math.min(1, value + 0.2)))}>
              +20%
            </Button>
          </Row>
        </Section>

        <Section title="EmptyState and ErrorState" note="A failed read is never shown as “nothing here”. Gone and unreachable are different: only one of them offers Retry.">
          <div className="gallery__states">
            <div className="gallery__card">
              <EmptyState icon={<Inbox size={28} />} title="Nothing needs you" description="Approvals, questions and finished runs will appear here." action={<Button variant="tinted">Open the workbench</Button>} compact />
            </div>
            <div className="gallery__card">
              <ErrorState error={new ApiError(404, 'not_found', 'Not found.')} actions={<Button variant="tinted">Start a new session</Button>} compact />
            </div>
            <div className="gallery__card">
              <ErrorState error={new ApiError(0, 'network_error', 'Failed to fetch')} onRetry={() => toast.info('Retrying')} compact />
            </div>
            <div className="gallery__card">
              <ErrorState error={new ApiError(403, 'owner_required', 'Only the owner can do that.')} compact />
            </div>
          </div>
        </Section>

        <Section title="Banner and StaleNotice">
          <div className="gallery__form">
            <Banner>A neutral note in the flow of the page.</Banner>
            <Banner tone="info" title="Your session ended">
              Sign in again to carry on where you were.
            </Banner>
            <Banner tone="success">Saved.</Banner>
            <Banner tone="warning" action={<Button variant="plain" size="sm">Retry</Button>}>
              Showing the projects from the last successful read.
            </Banner>
            <Banner tone="danger">That username or password is not correct.</Banner>
            <div>
              <StaleNotice /> <StaleNotice since={Date.now() - 7 * 60_000} reason="The server could not be reached." />
            </div>
          </div>
        </Section>

        <Section title="Badge, ActivityMark, Avatar, Logo">
          <Row label="Badge">
            <Badge>Neutral</Badge>
            <Badge tone="accent">This device</Badge>
            <Badge tone="positive">On</Badge>
            <Badge tone="warning">Archived</Badge>
            <Badge tone="danger">Locked</Badge>
            <Badge tone="info">Running</Badge>
            <CountBadge count={7} label="7 unread" />
            <CountBadge count={128} label="128 unread" />
          </Row>
          <Row label="Activity">
            <ActivityMark kind="running" /> <span className="text-footnote">running</span>
            <ActivityMark kind="attention" /> <span className="text-footnote">needs you</span>
            <ActivityMark kind="unseen" /> <span className="text-footnote">finished, unseen</span>
          </Row>
          <Row label="Avatar">
            <Avatar name="Ada" size={28} />
            <Avatar name="小宋" />
            <Avatar name="grace" size={56} />
            <Avatar name="Linus" size={56} tint="green" />
          </Row>
          <Row label="Logo">
            <LogoMark size={40} />
            <LogoMark size={40} plated />
            <LogoMark size={72} plated label="Agent Studio" />
          </Row>
        </Section>

        <Section title="Markdown and CodeBlock" note="For untrusted text: raw HTML dropped, links made safe, remote images not fetched until tapped.">
          <div className="gallery__card gallery__card--prose">
            <Markdown>{SAMPLE_MARKDOWN}</Markdown>
          </div>
        </Section>
      </div>
    </Screen>
  );
}
