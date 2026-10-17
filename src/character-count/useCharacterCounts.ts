import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Chapter, LibraryView } from '../model';
import { CharacterCountLoader, deriveCharacterCounts, type EditorCharacterCounts, type WorkCharacterCounts } from './index';

export function useCharacterCounts(library: LibraryView | null, chapter: Chapter | null, blocked: boolean) {
  const [persisted, setPersisted] = useState<WorkCharacterCounts | null>(null);
  const [live, setLive] = useState<EditorCharacterCounts | null>(null);
  const [loader] = useState(() => new CharacterCountLoader({ characterCounts: workId => invoke('character_counts', { workId }) }, setPersisted));
  const work = library?.works.find(item => item.id === chapter?.workId);
  const directory = JSON.stringify((library?.entries ?? []).map(entry => [entry.contentId, entry.kind]));
  useEffect(() => {
    loader.invalidate();
    if (!blocked && work && chapter) void loader.refresh(work.id);
    return () => loader.invalidate();
  }, [loader, library?.path, work?.id, work?.structureRevision, chapter?.id, chapter?.revision, directory, blocked]);
  const current = live?.contentId === chapter?.contentId ? live : null;
  const counts = useMemo(() => {
    if (!persisted || !current || !chapter || !work || blocked) return null;
    const entries = library?.entries ?? [];
    // The request is tied to this view generation; validate its complete directory
    // and the current save receipt before overlaying unsaved editor text.
    if (entries.length !== persisted.contents.length || entries.some(entry => !persisted.contents.some(item => item.contentId === entry.contentId && item.kind === entry.kind))) return null;
    const revisions = Object.fromEntries(persisted.contents.map(item => [item.contentId, item.revision]));
    revisions[chapter.contentId] = chapter.revision;
    return deriveCharacterCounts(persisted, { workId: work.id, structureRevision: work.structureRevision, revisions }, { ...current, revision: chapter.revision });
  }, [persisted, current, chapter?.revision, chapter?.contentId, work?.id, work?.structureRevision, directory, blocked]);
  return { counts, live: current, onCounts: setLive };
}
