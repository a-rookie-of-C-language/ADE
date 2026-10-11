import type { OpenFile } from '../components/EditorPane';

export function canRelocateActive(tabs: OpenFile[], from: string, to: string, revision: string): boolean {
  return tabs.some((tab) => tab.path === from && tab.revision === revision) &&
    !tabs.some((tab) => tab.path === to);
}

export function relocateFileTabs(tabs: OpenFile[], from: string, to: string, revision: string): OpenFile[] {
  const destinationOpen = tabs.some((tab) => tab.path === to);
  return tabs.map((tab) => {
    if (tab.path !== from) return tab;
    if (tab.revision !== revision || destinationOpen) {
      return { ...tab, conflict: { content: null, revision: null }, comparing: false };
    }
    return { ...tab, path: to,
      conflict: tab.conflict?.content === null ? undefined : tab.conflict };
  });
}
