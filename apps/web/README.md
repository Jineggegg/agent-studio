# Agent Studio — web client

A touch-first PWA for phone, tablet and desktop. React 19, react-router 8,
TanStack Query, zustand, zod; hand-written CSS on design tokens; no UI framework.

This README is the guide for **feature engineers**. Everything a feature needs
— a route, a settings page, a home tile, data, live events, components — is
reached through the small set of APIs below. If you find yourself working
around one of them, that is a gap in the foundation: say so rather than
building a second way.

```
npm run dev                         # from the repository root: server + Vite on http://127.0.0.1:5420
npx tsc -p apps/web                 # types
npx eslint apps/web                 # lint
npx vitest run --project web        # unit tests (jsdom)
npm run build -w @agent-studio/web  # production build into apps/web/dist
```

`http://127.0.0.1:5420/dev/components` (development builds only) shows every
component in every state. Look there before writing a new one.

After `npm run build`, **restart the server**: it lists `dist/` once at start,
so the freshly hashed files of a new build are unknown to a running one.

---

## Rules

1. **Talk to the server only through `api` and `realtime`.** They carry the
   anti-forgery header, end the session on 401, run the step-up dialog on
   `reauth_required`, validate answers, and reconnect. Never call `fetch` or
   `new WebSocket` yourself.
2. **Every string goes through i18n**, in both `en.ts` and `zh-CN.ts`. A test
   fails when the two key sets differ.
3. **Every interactive element has a hit area of at least 44 × 44 CSS px**,
   however small it is drawn. The components already do; keep it true for
   anything custom. Form text is at least 16 px (`--text-field`), so iOS never zooms.
4. **Three layout classes, from the viewport width alone**: phone ≤ 699,
   tablet 700–1023, wide ≥ 1024. Use `useLayoutClass()` in components and
   `:root[data-layout='phone']` in CSS. No other breakpoints, no device sniffing.
5. **Untrusted text is rendered with `<Markdown>`**, never as HTML.
   `dangerouslySetInnerHTML` is a lint error.
6. **Colours, spacing, radii, motion come from tokens** (`src/styles/tokens.css`).
   No raw hex values in feature CSS. Every screen must work in light and dark,
   with reduced motion (slides become cross-fades — you get this for free by
   using the motion tokens), increased contrast and reduced transparency.
7. **Overlays add no history.** Sheets, dialogs and menus open from state, not
   from routes. Deeper levels are pushed; siblings (tabs) replace.
8. **A failed read is not an empty state.** Use `ErrorState` (it tells "gone"
   from "unreachable + Retry"); keep older data on screen with a `StaleNotice`.
9. **No placeholder screens.** A route exists when its feature exists.
10. **Enter during input-method composition never submits.** `TextField`,
    `TextArea` and `Form` handle it; for anything custom use `isImeConfirm(event)`.

---

## Directory layout

```
apps/web
  index.html              launch screen and launch-error screen (inline styles, no script)
  public/
    boot.js               runs first: theme before first paint, launch screen hand-over, launch errors
    sw.js                 service worker (plain JS): offline notice, asset cache, push, notification clicks
    offline.html          the offline notice
    reset.html, reset.js  public recovery page: clears caches and the worker
    manifest.webmanifest, favicon.svg, icons/   (PNGs come from scripts/generate-icons.mjs)
  src/
    main.tsx              start-up order
    styles/               tokens.css (every raw value), base.css (reset, app frame, utilities)
    ui/                   the design system — import from '@/ui'   (Markdown: '@/ui/markdown')
    platform/             layout class, visual viewport + keyboard, theme, media queries, clipboard, long press
    data/                 api client, session, realtime, preferences, query client, projects, errors, connection
    i18n/                 en.ts, zh-CN.ts, translator
    registry/             where features plug in: routes, settings pages, home tiles, sign-in methods
    shell/                app frame, screen stack and transitions, Screen scaffold, back, history, scroll
                          restoration, launch, lazy loading, error boundaries, connection cue
    pwa/                  service-worker registration, update detection
    features/
      index.ts            one import per feature — add yours here
      auth/               sign-in, setup, step-up dialog, passkeys
      home/               launcher, project sheets, folder picker
      settings/           settings shell and the foundation's pages
      workbench/          the chat surface: conversations, transcript, composer, approvals, runs,
                          and the inspector that other features add their panels to
      dev/                component gallery (development builds only)
    test/                 test set-up and helpers (renderInApp, jsonResponse, errorResponse)
```

Styles are plain CSS files next to what they style, class names prefixed by
area (`ui-…` for the design system, then `home…`, `settings-…`, `auth…`).
Variants and states are data attributes (`data-variant`, `data-tone`,
`aria-selected`), not modifier classes.

---

## Adding a feature

A feature is a directory under `src/features/<name>/` with an `index.ts` that
only *registers* things, plus one line in `src/features/index.ts`:

```ts
// src/features/index.ts
import './inbox';
```

```ts
// src/features/inbox/index.ts — registrations and lazy loaders only, so the feature's code downloads on first use
import { Bell, Inbox } from 'lucide-react';
import { registerFeatureRoutes, registerSettingsPage, registerSystemTile } from '@/registry';
import { useInboxTileStatus } from './status';

registerFeatureRoutes({ path: 'inbox', name: 'inbox.title', load: () => import('./InboxScreen') });
registerSystemTile({ id: 'inbox', title: 'inbox.title', icon: Inbox, tint: 'red', to: '/inbox', order: 20, useStatus: useInboxTileStatus });
registerSettingsPage({ id: 'notifications', title: 'settings.notifications.title', group: 'general', icon: Bell, tint: 'red', load: () => import('./NotificationSettings') });
```

### A route

```ts
registerFeatureRoutes(...routes: FeatureRoute[]): void

interface FeatureRoute {
  path: string;                                    // no leading slash: 'inbox', 'workbench/*', 'projects/:projectId/*'
  load: () => Promise<{ default: ComponentType }>; // () => import('./Screen')
  name?: MessageKey;                               // for the "Loading …" placeholder
  access?: 'user' | 'owner';                       // default 'user'
  preloadWhenIdle?: boolean;                       // download in the background (heaviest surfaces)
}
```

You get: lazy loading with a named placeholder, an in-place "Retry" when the
download fails, an error boundary of your own (a crash leaves the shell
usable), the sign-in guard, and the open/close/push/pop transition.

Planned paths: `workbench/*`, `projects/:projectId/*`, `inbox`, `memory`,
`usage`. The home screen opens a project's page as soon as a route matching
`/projects/<id>` is registered (`projectPath(id)`); until then it shows the
project's details sheet.

The screen itself is built on `Screen`:

```tsx
import { Screen } from '@/shell/Screen';

export default function InboxScreen() {
  const t = useT();
  return (
    <Screen title={t('inbox.title')} actions={<IconButton label={t('common.retry')} icon={<RefreshCw size={21} />} onClick={refresh} />}>
      <List>…</List>
    </Screen>
  );
}
```

`Screen` gives you the navigation bar with a back control that names where it
goes, a large title that collapses on scroll, one scroll area whose position
is restored when the user returns, safe-area padding, the tab title, and the
launch-screen hand-over. Props: `title`, `caption`, `subtitle`, `parent`
(`{ to, label }`, default Home; `null` for no back), `actions`, `leading`,
`largeTitle`, `toolbar` (tabs or a search field under the bar), `footer`
(a bar docked to the bottom; stays above the soft keyboard), `width`
(`'reading' | 'wide' | 'full'`), `scrollId`, `scrollRef`.

**Back** is the same thing everywhere — the bar's control, Escape, ⌘[ / Ctrl+[
and a swipe from the left edge: return to where the user came from in this
app, or, on a cold start, go to `parent` (replacing the entry, so the
browser's back cannot loop). Call `performBack()` (from `@/shell/back`) to
trigger it yourself. A screen that needs Escape for something else (stopping a
run) handles `keydown` and calls `event.preventDefault()`; a surface with its
own keys (an editor, a terminal) sets `data-keys="own"`.

**Screens inside your app** (a conversation pushed over a list, tabs): use
`ScreenStack` with `useRouteTransition`, exactly as `features/settings/SettingsShell.tsx`
does. Tabs that are routes change with `navigate(to, { replace: true })`.

```tsx
<ScreenStack screenKey={sessionId ?? ':list'} kind={useRouteTransition(sessionId ?? ':list', useNavigationType(), isSystemGesturePop)}>
  {sessionId ? <SessionScreen id={sessionId} /> : <SessionList />}
</ScreenStack>
```

`useScreenActive()` is false while your screen is leaving or covered (the home
screen under an open app): stop polling and decorative animation then.

### A settings page

```ts
registerSettingsPage(...pages: SettingsPage[]): void

interface SettingsPage {
  id: string;                    // the address: /settings/<id>
  title: MessageKey;
  icon: LucideIcon;
  tint: Tint;
  group: 'account' | 'general' | 'assistants' | 'connections' | 'system';
  order?: number;                // within the group, default 100
  access?: 'user' | 'owner';
  load: () => Promise<{ default: ComponentType }>;
  useSummary?: () => string | undefined;   // the current value, shown on the page's row
  parent?: string;               // id of the page this one is a level below (no row of its own)
}

registerSettingsQuickControl({ id, order?, Component })   // a one-tap control on the settings root
settingsPath(id?: string): string                         // '/settings/<id>' for links from elsewhere
```

The page component renders only its content — `List`s and friends. The shell
supplies the title, the split view on tablet and wide, push navigation with
scroll restoration on phone, and the deep link. See `features/settings/pages/AboutPage.tsx`.

### A home tile

```ts
registerSystemTile(...tiles: SystemTile[]): void

interface SystemTile {
  id: string; title: MessageKey; icon: LucideIcon; tint: Tint;
  to: string;                    // a registered route
  order?: number; access?: 'user' | 'owner';
  useStatus?: () => { text: string; tone?: 'neutral' | 'attention' | 'positive' | 'danger' } | null;
}
```

Return `null` from `useStatus` while the state behind it is loading. Project
tiles come from `/api/projects`; they are not registered.

### Another way to sign in

`registerSignInMethod({ id, order?, Component })` — the component receives
`{ disabled, onBusyChange, onMessage }` and returns `null` where it cannot
work, so the sign-in screen never shows a dead button. Passkeys are done this
way (`features/auth/PasskeySignIn.tsx`).

### A project tool beside the chat (the workbench's inspector)

The workbench (`features/workbench/`) owns the chat and an area beside it for
a project's tools — files, a terminal, Git, a preview. A tool is a **panel**
registered from its own feature; the workbench supplies the container:

| Layout | The inspector is… |
| --- | --- |
| wide | a docked column right of the chat, resized by dragging its edge (or ←/→ on the handle); the chat keeps at least 380 px |
| tablet | a panel floating over the chat's trailing side |
| phone | a full-screen layer over the chat, closed with its own control or Escape |

Which panel is on show, whether the inspector is open and how wide it is are
remembered per device. **With no panel registered there is no inspector at
all** — no empty column, no toggle in the title bar, no ⌘J.

```ts
// src/features/files/index.ts
import { FolderTree } from 'lucide-react';
import { registerInspectorPanel } from '@/features/workbench/inspector/registry';

registerInspectorPanel({
  id: 'files',
  title: 'files.title',
  icon: FolderTree,
  order: 10,
  handles: ['open-file', 'reveal-folder'],
  load: () => import('./FilesPanel'),
});
```

```ts
registerInspectorPanel(...panels: InspectorPanel[]): void

interface InspectorPanel {
  id: string;                    // lower-case, stable: 'files', 'terminal', 'git', 'preview'
  title: MessageKey;
  icon: LucideIcon;
  order?: number;                // among the tabs, default 100
  load: () => Promise<{ default: ComponentType<InspectorPanelProps> }>;
  available?: (context: InspectorContext) => boolean;   // default: only inside a project
  handles?: readonly InspectorRequestType[];            // the chat's requests this panel answers
  keepAlive?: boolean;           // stay mounted (hidden) once opened — a terminal keeps its shell
  useBadge?: (context: InspectorContext) => { count?: number; mark?: ActivityKind; label: string } | null;
}

interface InspectorContext { project: Project | null; sessionId: string | null; role: Role }

interface InspectorPanelProps {
  project: Project | null;       // the project on show
  sessionId: string | null;      // the open conversation; null before its first message
  active: boolean;               // this panel is the one on show — pause polling and animation otherwise
  presentation: 'docked' | 'floating' | 'fullscreen';
  request: InspectorRequest | null;   // something the chat asked for; handle it in an effect…
  onRequestHandled: () => void;       // …then say so
  close: () => void;             // closes the inspector
}

type InspectorRequest =
  | { type: 'open-file'; path: string; line?: number }
  | { type: 'reveal-folder'; path: string }
  | { type: 'run-command'; text: string }
  | { type: 'show-changes'; path?: string };
```

The panel's default export renders only its content and fills the area it is
given (`height: 100%`, its own scrolling); the container draws the tabs, the
close control and the resize handle. A panel with its own keys (an editor, a
terminal) sets `data-keys="own"` on its root, as everywhere else.

**The chat talks to panels through requests.** A control that needs a tool is
drawn only when an available panel `handles` that request, so nothing in the
transcript is ever a dead button:

```tsx
import { useInspectorAction } from '@/features/workbench/inspector/scope';

const openFile = useInspectorAction('open-file');   // null when no panel handles it
{openFile && <button onClick={() => openFile({ type: 'open-file', path })}>…</button>}
```

Today the transcript asks for `open-file` (a read or an edit's file, each file
of a diff, and a link to a file in what the agent wrote — which copies the
path while no panel can open it) and `run-command` (a command an agent ran).
Outside React:
`panelHandling(type, context)` and `requestInspector(request, context)` (returns
false and does nothing when no panel answers). Also exported:
`inspectorPanels(context)`, `showInspectorPanel(id)`, `setInspectorOpen(open)`,
`toggleInspector()`, `setInspectorWidth(px)`, `useInspectorState()`.

In a development build the workbench registers two stand-in panels
(`features/workbench/dev/`) so the container can be looked at; a production
build contains neither.

**Workbench addresses** — everything is under `/workbench`, and the helpers in
`features/workbench/routes.ts` build them (`workbenchPaths.session(projectId, sessionId)`):

```
/workbench                         where the user left off (or a new conversation)
/workbench/p/<project>             that project: its last conversation, or a new one
/workbench/p/<project>/new         a new conversation there
/workbench/p/<project>/s/<session> a conversation
/workbench/s/<session>             the same, when only the session is known — corrected to the full address
/projects/<project>                redirects to /workbench/p/<project>  (this is what `projectPath(id)` gives)
```

Link to a conversation from anywhere with `workbenchPaths.lookup(sessionId)`; an
address that names the wrong project, or a session that is gone, corrects
itself or says so with a way on.

---

## Data

### Requests

```ts
import { api, ApiError, isApiError } from '@/data/api';

const project = await api.get(`/api/projects/${id}`, { schema: projectSchema });
await api.patch(`/api/projects/${id}`, { name });
await api.post('/api/things', body, { schema, query: { limit: 20 }, signal, timeoutMs: 30_000 });
await api.delete(`/api/things/${id}`);
```

- Paths are same-origin and start with `/`; anything else throws.
- Pass the zod schema from `@agent-studio/protocol` whenever one exists: it
  validates the answer and types the result.
- Failures throw `ApiError { status, code, message, details }` with
  `.unreachable` (network / 5xx / timeout — offer Retry), `.gone` (404),
  `.retryAfterSeconds`, `.fieldIssues`. Client-side codes: `network_error`,
  `timeout`, `aborted`, `invalid_response`, `reauth_cancelled`.
- `describeError(error, t)` (`@/data/errors`) turns any of them into a
  sentence in the user's language. Known server codes are translated under
  `errors.<code>`; add a line to both dictionaries for each code your feature's
  routes can return.
- `401` ends the session and shows sign-in (and returns the user to where they
  were afterwards). `5xx` and network failures never do.
- `403 reauth_required` opens the step-up dialog and repeats your request once.
  If the user cancels you get `reauth_cancelled` — treat it as "nothing happened".

### Queries

Use TanStack Query directly; `queryClient` (`@/data/query`) is set up for a
phone: 30 s freshness, re-read of stale on-screen data when the page becomes
visible, no polling while hidden, two retries only where retrying can help.

```ts
const sessions = useQuery({
  queryKey: ['sessions', projectId],
  queryFn: ({ signal }) => api.get(`/api/projects/${projectId}/sessions`, { schema, signal }),
  meta: { live: true },      // mirrors live status: re-read the moment the live connection returns
});
const { stale, since } = useStaleness(sessions);     // '@/data/connection'
```

- First load: skeletons, held back 140 ms (`DelayedSkeleton`, `useDelayedFlag`). Never the progress line.
- User-initiated refresh: `progress.track(promise)` or `useProgress(isRefreshing)`.
- Error with no data: `<ErrorState error={q.error} onRetry={q.refetch} />`. Error with older data: keep it and show `<StaleNotice since={since} />`.
- Polling: `refetchInterval` plus `enabled: useScreenActive()`.

Projects are already there: `useProjects()`, `useCreateProject()`,
`useUpdateProject()`, `useRemoveProject()`, `useProjectsLiveUpdates()`,
`useFolderListing()` in `@/data/projects`.

### Live events

One WebSocket per tab, shared. Disconnection is normal; the store reconnects
for ever with back-off, asks each topic for what it missed, and never delivers
a numbered event twice.

```ts
import { realtime, useRealtimeTopic, useOnReconnect, useRealtimeStatus } from '@/data/realtime';

useRealtimeTopic(`session:${id}`, (event) => apply(event.type, event.data), {
  after: lastSeq,                                  // the last sequence number you already hold
  onSnapshot: (snapshot) => showPartial(snapshot), // in-flight state, on every (re)subscription
  onRejected: (code) => …,                         // not yours, or no such topic
});
useOnReconnect(() => refetchWhatCannotBeReplayed());

// outside React
const stop = realtime.subscribe(topic, handler, { after });
```

`event` is `{ topic, type, data, seq, at }`. Validate `data` with a schema
before using it. Topics are `<kind>:<key>`; the server authorises each.
The server allows a connection 60 frames per 30 s; the client paces itself
below that, so a burst of subscriptions is spread out — subscribe to what is
on screen, not to everything.

### Session, preferences

```ts
import { useSession, useUser, useIsOwner } from '@/data/session';
import { onSessionEnd } from '@/data/auth';                 // erase what your feature keeps on the device
import { usePreference, setPreference } from '@/data/preferences';

const mode = usePreference('usage.display', (v) => (v === 'used' ? 'used' : 'remaining'));
setPreference('usage.display', 'used');   // applied now, saved after 400 ms, synced to other devices live
```

Preferences are account-wide (`<feature>.<name>` keys, JSON values, 64 kB per
value). Always parse what you read. Per-device memory (a collapsed panel, a
panel width) is not a preference: keep it in `localStorage` under a
`studio.<feature>.…` key and clear it in `onSessionEnd` if it names anything
of the user's.

### Unsaved work and updates

A page that has been open across a deployment reloads itself when nothing can
be lost. Declare what can be: `useUnsavedWork(dirty)` (`@/pwa/update`). A
focused field holding text and any open sheet already block it.

---

## Platform hooks

| Hook | From | For |
| --- | --- | --- |
| `useLayoutClass()` → `'phone' \| 'tablet' \| 'wide'` | `@/platform/layout` | every size-dependent layout decision |
| `useKeyboard()` → `{ open, inset }` | `@/platform/viewport` | knowing the soft keyboard is up |
| `useKeyboardDock(ref)` | `@/platform/viewport` | a composer or toolbar docked to the bottom: keeps its focused field in view and reports the keyboard |
| `useScreenActive()` | `@/shell/ScreenStack` | pausing polling and animation while covered or leaving |
| `useReducedMotion()`, `useCanHover()`, `usePageVisible()`, `useBrowserOnline()`, `useMediaQuery(q)` | `@/platform/media` | |
| `useConnectionState()` → `'online' \| 'reconnecting' \| 'offline'`, `useStaleness(query)` | `@/data/connection` | labelling stale data |
| `useLongPress(handler, { delay, tolerance })` | `@/platform/long-press` | long press that swallows its click; pair with class `u-no-callout` |
| `useTheme()`, `useThemePreference()` | `@/platform/theme` | reading the theme (set it with `chooseTheme` from `@/shell/appearance`) |
| `copyText(text)` | `@/platform/clipboard` | copying; works on plain-http LAN addresses too |
| `useDocumentTitle(title)`, `useScrollRestoration(ref, id)`, `useBack(parent)` | `@/shell/*` | what `Screen` does, for custom scaffolds |
| `useUnsavedWork(dirty)`, `checkForUpdate()` | `@/pwa/update` | |

**The keyboard.** The app frame is exactly as tall as the visual viewport, so
anything docked to the bottom of its column sits directly above the soft
keyboard with no code at all, and returns when it closes. While the keyboard
is open `--safe-bottom` is `0` (the home indicator is underneath it). Raise
toasts above your own bottom bar by setting `--toast-offset` on `.app`.

---

## i18n

```ts
const t = useT();
t('inbox.title')
t('inbox.updated', { when: t.relative(item.updatedAt) })
t.plural('inbox.count', items.length)          // needs 'inbox.count.one' and 'inbox.count.other'
t.number(n) · t.date(ts, 'date' | 'time' | 'dateTime' | 'weekday' | 'monthDay' | 'short') · t.relative(ts) · t.duration(seconds) · t.list(items)
```

Add keys to `src/i18n/en.ts` (the source of the `MessageKey` type) and
`src/i18n/zh-CN.ts`. Outside React use `currentTranslator()`. Server error
codes: `errors.<code>`; audit actions: `audit.<action>`.

---

## Components (`@/ui`)

| Component | One-line usage |
| --- | --- |
| `Button` | `<Button variant="primary" loading={saving} loadingLabel={t('…')} onClick={save}>{t('common.save')}</Button>` — variants `primary · tinted · neutral · plain · danger · plain-danger`; sizes `sm · md · lg`; `block`, `icon` |
| `IconButton` | `<IconButton label={t('home.refresh')} icon={<RefreshCw size={21} />} busy={refreshing} onClick={refresh} />` — `label` is required (name + tooltip); `variant="filled"`, `tone` |
| `TextField` | `<TextField label={t('…')} value={v} onChange={setV} hint="…" error={problem} onEnter={submit} />` — `type="password"` adds show/hide; `secret`, `mono`, `optional`, `leading`, `trailing` |
| `TextArea` | `<TextArea label="…" value={v} onChange={setV} autoGrow maxRows={8} onSubmit={send} />` — Enter submits, Shift+Enter breaks the line |
| `Form` | `<Form onSubmit={submit}>…</Form>` — input-method-safe Enter, no page reload |
| `Switch` | `<Switch checked={on} onChange={setOn} label="…" />` — inside a `ListRow` use `control={<Switch … />}` and drop `label` |
| `Checkbox` | `<Checkbox checked={c} onChange={setC} label="Read" hint="…" />` — several of a short list |
| `SegmentedControl` | `<SegmentedControl label="…" value={v} onChange={setV} options={[{ value, label, icon? }]} />` — two to four modes |
| `Select` | `<Select label="…" value={v} onChange={setV} options={[{ value, label, hint? }]} block />` — a menu; a bottom sheet on phone |
| `Menu`, `MenuButton` | `<MenuButton label={t('common.moreActions')} items={[{ id, label, icon, tone?: 'danger', onSelect }]} />` |
| `List`, `ListRow` | `<List header="…" footer="…"><ListRow leading={<Glyph … />} title="…" subtitle="…" value="…" to="/x" /></List>` — also `onPress`, `control`, `trailing`, `selected`, `tone`, `actions` (swipe-to-reveal, plus the same actions under a "…" button) |
| `NavigationBar`, `LargeTitle` | normally through `Screen`; standalone: `<NavigationBar title="…" back={{ label, onPress }} trailing={…} />` |
| `Sheet` | `<Sheet open={open} onClose={close} title="…" footer={<Button …/>}>…</Sheet>` — bottom sheet with drag-to-dismiss on phone, dialog otherwise; `size`, `fill`, `flush`, `dismissible`, `leading`, `trailing`; focus an element first with `data-autofocus` |
| `ConfirmDialog`, `confirm()` | `if (await confirm({ title: 'Remove “x”?', message: '…', confirmLabel: t('common.remove'), tone: 'danger' })) …` |
| `toast` | `toast.success(t('…'))` · `toast.error(describeError(e, t))` · `toast.show({ title, detail, action: { label: t('common.undo'), onSelect }, duration: 'persistent', id })` |
| `Skeleton`, `SkeletonText`, `DelayedSkeleton`, `useDelayedFlag` | `<DelayedSkeleton label={t('common.loading')}><Skeleton width={56} height={56} radius={16} /></DelayedSkeleton>` |
| `ProgressLine`, `progress`, `useProgress` | `await progress.track(refetch())` · inline: `<ProgressLine inline active value={0.4} />` |
| `EmptyState` | `<EmptyState icon={<Inbox size={28} />} title="…" description="…" action={<Button …/>} />` |
| `ErrorState` | `<ErrorState error={query.error} onRetry={() => query.refetch()} actions={…} />` — picks gone / unreachable / forbidden from the error |
| `Banner` | `<Banner tone="danger">{message}</Banner>` — tones `neutral · info · success · warning · danger`; `title`, `action` |
| `StaleNotice` | `<StaleNotice since={query.dataUpdatedAt} reason="…" />` |
| `Badge`, `CountBadge` | `<Badge tone="accent">{t('…')}</Badge>` · `<CountBadge count={n} label={t.plural('…', n)} />` |
| `ActivityMark`, `topActivity` | `<ActivityMark kind="running" />` — kinds `running · attention · unseen`; differ in shape as well as colour and are announced |
| `Spinner`, `LoadingRow` | `<Spinner size={20} label="…" />` · `<LoadingRow label={t('common.loading')} />` |
| `Avatar` | `<Avatar name={user.displayName} size={40} />` |
| `Glyph` | `<Glyph icon={<Bell size={18} />} tint="red" />` — an icon on a duotone plate |
| `Tabs`, `tabPanelProps` | `<Tabs label="…" idBase="tools" value={tab} onChange={setTab} tabs={[{ value, label, accessory? }]} />` then `<div {...tabPanelProps('tools', tab)}>` |
| `LogoMark` | `<LogoMark size={52} plated />` |
| `Markdown`, `CodeBlock` | `import { Markdown } from '@/ui/markdown'` → `<Markdown>{source}</Markdown>` — `compact`, `resolveImage`, `remoteImages`, `onLinkClick` |

Icons are `lucide-react`, sized 18–22 px in rows and bars.

`Markdown` drops raw HTML, keeps only http(s) and relative link targets
(opened with `noopener noreferrer`), and never fetches a remote image by
itself. The server's Content-Security-Policy (`img-src 'self' data: blob:`)
means a remote image cannot be shown inline at all today, so by default the
placeholder opens it in a new tab; pass `resolveImage` to map references to
same-origin URLs your feature serves.

---

## Tokens (`src/styles/tokens.css`)

| Group | Names |
| --- | --- |
| Surfaces | `--color-bg` `--color-surface` `--color-surface-alt` `--color-sunken` `--color-fill` `--color-fill-hover` `--color-fill-pressed` `--color-material-bar` `--color-material-sheet` `--color-scrim` |
| Text | `--color-text` `--color-text-secondary` `--color-text-tertiary` `--color-text-disabled` |
| Lines | `--color-separator` `--color-separator-strong` `--color-focus` |
| Accent | `--color-accent` `--color-accent-hover` `--color-accent-pressed` `--color-on-accent` `--color-accent-text` `--color-accent-soft` `--color-accent-soft-hover` |
| Status (text + soft background) | `--color-danger` `--color-positive` `--color-warning` `--color-info`, each with `…-soft` |
| Marks (graphics) | `--color-mark-running` `--color-mark-attention` `--color-mark-unseen` `--color-mark-positive` `--color-mark-danger` |
| Tints | `--tint-<name>-soft` / `--tint-<name>-strong` for `blue sky teal green amber orange red pink purple slate`; set `data-tint="<name>"` and use `--tint-soft` / `--tint-strong` |
| Code | `--code-bg` `--code-text` `--code-comment` `--code-keyword` `--code-string` `--code-number` `--code-title` `--code-attr` |
| Type | `--font-sans` `--font-mono`; `--text-display` `--text-title-1` `--text-title-2` `--text-title-3` `--text-body` `--text-callout` `--text-footnote` `--text-caption` `--text-field` with matching `--leading-…`; `--weight-regular` `--weight-medium` `--weight-semibold` `--weight-bold`. Classes: `text-display` … `text-caption`, `text-secondary`, `text-tertiary` |
| Space | `--space-1` (4 px) `-2` `-3` `-4` `-5` `-6` `-8` `-10` `-12` `-16`; `--gutter` (page margin, grows with the layout class); `--content-max` |
| Shape | `--radius-xs` `--radius-sm` `--radius-md` `--radius-lg` `--radius-xl` `--radius-full` |
| Controls | `--hit-min` (44 px) `--control-height` `--control-height-lg` `--control-height-sm` `--bar-height` |
| Elevation | `--shadow-1` `--shadow-2` `--shadow-3` `--ring-surface` |
| Motion | `--motion-instant` `--motion-fast` `--motion-base` `--motion-slow`; `--ease-out` `--ease-in` `--ease-in-out` `--ease-standard`; `--motion-distance` (1, or 0 under reduced motion — multiply every travel by it) and `--motion-fade-from` |
| Layers | `--z-base` `--z-sticky` `--z-bar` `--z-cue` `--z-overlay` `--z-sheet` `--z-menu` `--z-toast` `--z-progress` `--z-launch` |
| Safe areas | `--safe-top` `--safe-right` `--safe-bottom` `--safe-left` (use these, not `env()` directly) |
| Viewport | `--app-height` `--app-top` `--keyboard-inset` (kept by `platform/viewport.ts`) |

Utilities in `base.css`: `visually-hidden`, `u-scroll` (a vertical scroll area
that keeps its overscroll), `u-no-callout` (for anything that can be lifted
and dragged), `u-truncate`, `u-mono`, `u-tabular`.

**Writing motion.** Animate only `transform` and `opacity`. Write travel as
`calc(<distance> * var(--motion-distance))` and start opacity from
`var(--motion-fade-from)` when the element would otherwise slide in opaque;
under reduced motion the same keyframes become a short cross-fade. Durations
come from the `--motion-*` tokens (they shorten under reduced motion).

---

## Testing

Tests sit next to the source (`*.test.ts(x)`), run in jsdom, and use Testing
Library. `renderInApp(<Thing />, { route })` (`@/test/render`) wraps a
component in a router and a query client; `jsonResponse` / `errorResponse`
build server answers. Mock `@/data/auth` or stub `fetch`; do not start a
server. A test that needs plain Node starts with `// @vitest-environment node`
(see `pwa/sw.test.ts`).

To look at the real thing: build, start the server with a temporary data
directory, and open it at 390 × 844, 820 × 1180 and 1440 × 900 in light and
dark. Check the console: the server's CSP is `script-src 'self'`,
`style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:` — nothing may
be blocked (no inline scripts, no `eval`, no remote images or fonts).

```
AGENT_STUDIO_DATA_DIR=$(mktemp -d) AGENT_STUDIO_PORT=7510 AGENT_STUDIO_SETUP_TOKEN=local-setup-token-123456 \
AGENT_STUDIO_WEB_DIR=apps/web/dist npx tsx --tsconfig apps/server/tsconfig.json apps/server/src/main.ts
```

## Icons

`node scripts/generate-icons.mjs` rasterises the mark into
`public/icons/*.png` (Playwright's Chromium). The PNGs are committed; re-run
only when the mark changes, and bump the `?v=` stamp in `manifest.webmanifest`.
