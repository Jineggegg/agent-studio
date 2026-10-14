import type { Extension } from '@codemirror/state';

/**
 * Which language pack colours a file, decided by its name alone. Each pack is
 * downloaded the first time a file of its kind is opened; anything unknown is
 * shown as plain text.
 */
export type LanguageId = 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'json' | 'css' | 'html' | 'markdown' | 'python';

const BY_EXTENSION: Record<string, LanguageId> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  map: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  svg: 'html',
  xml: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
};

const BY_NAME: Record<string, LanguageId> = {
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  'tsconfig.json': 'json',
  'composer.lock': 'json',
};

export function languageIdFor(path: string): LanguageId | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

export const isMarkdown = (path: string): boolean => languageIdFor(path) === 'markdown';

export async function languageFor(path: string): Promise<Extension | null> {
  const id = languageIdFor(path);
  try {
    switch (id) {
      case 'javascript':
        return (await import('@codemirror/lang-javascript')).javascript();
      case 'jsx':
        return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
      case 'typescript':
        return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
      case 'tsx':
        return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
      case 'json':
        return (await import('@codemirror/lang-json')).json();
      case 'css':
        return (await import('@codemirror/lang-css')).css();
      case 'html':
        return (await import('@codemirror/lang-html')).html();
      case 'markdown':
        return (await import('@codemirror/lang-markdown')).markdown();
      case 'python':
        return (await import('@codemirror/lang-python')).python();
      default:
        return null;
    }
  } catch {
    // A language pack that fails to download costs the colours, never the file.
    return null;
  }
}
