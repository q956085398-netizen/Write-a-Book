import { characterCount, type Chapter } from '../model';
import { readDocument } from '../rich-content';

export const countingRule = '字数（含标点）：每个非空白 Unicode 码点计 1；英文逐字母计数，组合 emoji 不按可见字形合并。';
export interface EditorCharacterCounts { contentId: string; current: number; selection: number }
export interface ContentCharacterCount { contentId: string; kind: 'chapter' | 'fragment'; revision: number; count: number }
export interface WorkCharacterCounts { workId: string; structureRevision: number; contents: ContentCharacterCount[] }
export interface CharacterCountPort { characterCounts(workId: string): Promise<WorkCharacterCounts> }
export interface LiveCharacterCount extends EditorCharacterCounts { revision: number }
export interface CountContext { workId: string; structureRevision: number; revisions: Readonly<Record<string, number>> }
export interface DisplayCharacterCounts { selection: number; current: number; kind: 'chapter' | 'fragment'; chapters: number; fragments: number }

// Validate rich content before counting: unreadable data must never become a false zero.
export function bodyCharacterCount(chapter: Pick<Chapter, 'body' | 'bodyFormat'>): number {
  const doc = readDocument(chapter);
  const count = (node: typeof doc): number => node.type === 'text'
    ? characterCount(node.text ?? '')
    : node.type === 'managedImage' ? 0 : (node.content ?? []).reduce((sum, child) => sum + count(child), 0);
  return count(doc);
}

// The caller invalidates snapshots during structure/save requests and on errors.
// revisions contains every content ID in the active directory, preventing partial totals.
export function deriveCharacterCounts(snapshot: WorkCharacterCounts | null, context: CountContext, live: LiveCharacterCount | null): DisplayCharacterCounts | null {
  if (!snapshot || !live || snapshot.workId !== context.workId || snapshot.structureRevision !== context.structureRevision) return null;
  const ids = new Set<string>();
  let chapters = 0, fragments = 0;
  let current: ContentCharacterCount | undefined;
  for (const item of snapshot.contents) {
    if (ids.has(item.contentId) || !Number.isSafeInteger(item.count) || item.count < 0 || context.revisions[item.contentId] !== item.revision || !['chapter', 'fragment'].includes(item.kind)) return null;
    ids.add(item.contentId);
    const amount = item.contentId === live.contentId ? live.current : item.count;
    if (item.contentId === live.contentId) current = item;
    if (item.kind === 'chapter') chapters += amount; else fragments += amount;
  }
  if (!current || current.revision !== live.revision || ids.size !== Object.keys(context.revisions).length || !Number.isSafeInteger(live.current) || live.current < 0 || !Number.isSafeInteger(live.selection) || live.selection < 0) return null;
  return { selection: live.selection, current: live.current, kind: current.kind, chapters, fragments };
}

// A generation belongs to one view/save/structure state. Invalidate immediately
// when it changes, then refresh; a slower previous request cannot publish totals.
export class CharacterCountLoader {
  private generation = 0;
  constructor(private port: CharacterCountPort, private publish: (snapshot: WorkCharacterCounts | null) => void) {}
  invalidate(): void { this.generation++; this.publish(null); }
  async refresh(workId: string): Promise<void> {
    const generation = ++this.generation;
    this.publish(null);
    try {
      const snapshot = await this.port.characterCounts(workId);
      if (generation === this.generation) this.publish(snapshot.workId === workId ? snapshot : null);
    } catch { if (generation === this.generation) this.publish(null); }
  }
}
