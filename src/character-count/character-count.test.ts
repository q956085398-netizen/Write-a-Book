// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { CharacterCountLoader, bodyCharacterCount, deriveCharacterCounts, type WorkCharacterCounts } from './index';
import { characterCount } from '../model';
import { writeDocument } from '../rich-content';
const snapshot: WorkCharacterCounts = { workId: 'w', structureRevision: 2, contents: [{ contentId: 'a', kind: 'chapter', revision: 1, count: 5 }, { contentId: 'b', kind: 'fragment', revision: 0, count: 3 }] };
const context = { workId: 'w', structureRevision: 2, revisions: { a: 1, b: 0 } };
it('counts Chinese, mixed text, punctuation and Unicode code points with the existing whitespace rule', () => {
  expect(characterCount('中文， A!\n🙂')).toBe(6);
  expect(characterCount('👩‍💻 e\u0301')).toBe(5);
  expect(characterCount('\u0085\ufeff\u200b\u3000')).toBe(2);
  expect(bodyCharacterCount({ body: writeDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '中文， A!\n🙂' }] }, { type: 'managedImage', attrs: { attachmentId: '12345678-1234-1234-1234-123456789abc', alt: '不能计入字数' } }] }), bodyFormat: 'wab-rich-v1' })).toBe(6);
  expect(() => bodyCharacterCount({ body: '{}', bodyFormat: 'wab-rich-v1' })).toThrow();
});
it('replaces unsaved current count once, rejects stale, partial and duplicate totals', () => {
  const live = { contentId: 'a', revision: 1, current: 9, selection: 2 };
  expect(deriveCharacterCounts(snapshot, context, live)).toEqual({ current: 9, selection: 2, kind: 'chapter', chapters: 9, fragments: 3 });
  expect(deriveCharacterCounts(snapshot, { ...context, structureRevision: 3 }, live)).toBeNull();
  expect(deriveCharacterCounts(snapshot, context, { ...live, revision: 2 })).toBeNull();
  expect(deriveCharacterCounts({ ...snapshot, contents: [snapshot.contents[0]] }, context, live)).toBeNull();
  expect(deriveCharacterCounts({ ...snapshot, contents: [...snapshot.contents, snapshot.contents[0]] }, context, live)).toBeNull();
});
it('late previous-work requests cannot overwrite current-work or failed state', async () => {
  let finish!: (value: WorkCharacterCounts) => void;
  const publish = vi.fn();
  const port = { characterCounts: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error('offline')) };
  const loader = new CharacterCountLoader(port, publish);
  const pending = loader.refresh('w');
  loader.invalidate();
  await loader.refresh('other');
  finish(snapshot); await pending;
  expect(publish.mock.calls.every(([value]) => value === null)).toBe(true);
});
