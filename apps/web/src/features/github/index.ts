import { GitPullRequest } from 'lucide-react';
import { registerTitleBarItem } from '@/features/workbench/chat/slots';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
import { useGithubTileStatus } from './status';

/**
 * GitHub: the owner's pull requests and repositories, with a guarded merge —
 * through the `gh` login on the server. Registration only.
 *
 * The route is open to any signed-in person so that a link to it explains
 * itself; the tile and the branch chip are the owner's, because everything
 * behind them is.
 */
registerFeatureRoutes({ path: 'github/*', name: 'github.title', load: () => import('./GithubScreen') });

registerSystemTile({ id: 'github', title: 'github.title', icon: GitPullRequest, tint: 'slate', to: '/github', order: 40, access: 'owner', useStatus: useGithubTileStatus });

registerTitleBarItem({ id: 'branch', order: 10, load: () => import('./BranchChip'), available: ({ role }) => role === 'owner' });
