import type { MemoryFolder } from '@agent-studio/protocol';
import { Folder, Globe } from 'lucide-react';
import { projectSymbol } from '@/features/home/icons';

/** A folder's mark: the globe for Global, a project's own symbol, or a plain folder. */
export function FolderMark({ folder, name }: { folder: MemoryFolder | undefined; name: string }) {
  if (name === 'global' || folder?.kind === 'global') return <Globe size={14} aria-hidden="true" />;
  if (folder?.project) {
    const Icon = projectSymbol(folder.project.icon.symbol);
    return <Icon size={14} aria-hidden="true" />;
  }
  return <Folder size={14} aria-hidden="true" />;
}
