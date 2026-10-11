import type { OpenFile } from '../components/EditorPane';

export interface StoredDraft {
  path: string;
  content: string;
  saved: string;
  revision: string;
}

export interface DiskFile {
  content: string;
  revision: string;
}

export const MAX_DRAFTS = 30;
export const MAX_CHARS = 2 * 1024 * 1024;

export function draftKey(workspaceRoot: string, sessionId: string): string {
  return `ade:drafts:v1:${workspaceRoot}:${sessionId}`;
}

export function dirtyDrafts(tabs: OpenFile[]): StoredDraft[] {
  return tabs.filter((tab) => tab.content !== tab.saved || tab.conflict).map((tab) => ({
    path: tab.path, content: tab.content, saved: tab.saved, revision: tab.revision,
  }));
}

export function serializeDrafts(tabs: OpenFile[]): string {
  const drafts = dirtyDrafts(tabs);
  if (drafts.length > MAX_DRAFTS || drafts.some((draft) =>
    draft.content.length > MAX_CHARS || draft.saved.length > MAX_CHARS)) {
    throw new Error('Too many or too large local drafts');
  }
  return JSON.stringify(drafts);
}

export function parseDrafts(raw: string | null): StoredDraft[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_DRAFTS).filter((item): item is StoredDraft => {
      if (!item || typeof item !== 'object') return false;
      const draft = item as Record<string, unknown>;
      return typeof draft.path === 'string' && !!draft.path && !draft.path.startsWith('/') &&
        !draft.path.split('/').includes('..') && typeof draft.content === 'string' &&
        typeof draft.saved === 'string' && draft.content.length <= MAX_CHARS &&
        draft.saved.length <= MAX_CHARS && typeof draft.revision === 'string' &&
        /^[a-f0-9]{64}$/i.test(draft.revision);
    });
  } catch {
    return [];
  }
}

export function restoreDraft(draft: StoredDraft, disk: DiskFile | null): OpenFile | null {
  if (disk?.content === draft.content) return null;
  return {
    sessionId: crypto.randomUUID(), path: draft.path, content: draft.content,
    saved: disk?.revision === draft.revision ? disk.content : draft.saved,
    revision: draft.revision,
    ...(disk?.revision === draft.revision ? {} : { conflict: disk ?? { content: null, revision: null } }),
  };
}
