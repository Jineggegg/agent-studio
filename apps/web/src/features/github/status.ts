import { useQuery } from '@tanstack/react-query';
import { useIsOwner } from '@/data/session';
import { useT } from '@/i18n';
import type { TileStatus } from '@/registry';
import { githubApi, githubKeys } from './api';

/**
 * The line under the GitHub tile: what needs the owner, or why GitHub cannot
 * be asked. Read only while the home screen is on show, and from the server's
 * own short-lived cache, so the tile costs GitHub nothing extra.
 */
export function useGithubTileStatus(): TileStatus | null {
  const t = useT();
  const isOwner = useIsOwner();
  const account = useQuery({ queryKey: githubKeys.account, queryFn: ({ signal }) => githubApi.account(false, signal), enabled: isOwner, staleTime: 60_000, retry: false });
  const signedIn = account.data?.state === 'ready' || account.data?.state === 'limited';
  const inbox = useQuery({ queryKey: githubKeys.inbox('all'), queryFn: ({ signal }) => githubApi.inbox('all', false, signal), enabled: isOwner && signedIn, staleTime: 60_000, retry: false });

  if (!isOwner || !account.data) return null;
  if (!signedIn) {
    const state = account.data.state;
    return { text: state === 'tool_missing' ? t('github.tile.toolMissing') : state === 'unreachable' ? t('github.tile.unreachable') : t('github.tile.signedOut'), tone: state === 'unreachable' ? 'neutral' : 'attention' };
  }
  if (!inbox.data) return null;
  const { reviewRequested, all } = inbox.data.counts;
  if (reviewRequested > 0) return { text: t.plural('github.tile.review', reviewRequested), tone: 'attention' };
  if (all > 0) return { text: t.plural('github.tile.open', all), tone: 'neutral' };
  return { text: t('github.tile.none'), tone: 'neutral' };
}
