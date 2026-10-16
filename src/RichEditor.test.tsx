// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RichEditor } from './RichEditor';
import { EditorSession } from './editor-session';
import { documentText } from './rich-content';
import type { Chapter, SaveChapter } from './model';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./application', () => ({ application: { readImage: vi.fn(), importImage: vi.fn() } }));
it('mounting and read-only transitions do not convert or save legacy text, then DOM composition saves only completed Chinese', async () => {
  const chapter: Chapter = { id: 'c', contentId: 'content', workId: 'w', title: '第一章', body: '{"doc":"原文"}', bodyFormat: 'plain-text', revision: 0 };
  const saveChapter = vi.fn(async (draft: SaveChapter) => ({ ...chapter, ...draft, revision: draft.expectedRevision + 1 }));
  const session = new EditorSession({ saveChapter }); session.load(chapter);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<RichEditor chapter={chapter} session={session} disabled={false}/>));
    await act(async () => root.render(<RichEditor chapter={chapter} session={session} disabled={true}/>));
    await act(async () => root.render(<RichEditor chapter={chapter} session={session} disabled={false}/>));
    expect(session.getSnapshot().chapter).toEqual(chapter); expect(await session.flush()).toBe(true); expect(saveChapter).not.toHaveBeenCalled();
    const body = container.querySelector('#chapter-body')!;
    await act(async () => {
      body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      body.querySelector('p')!.textContent = 'zhongwen';
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(await session.flush()).toBe(false); expect(saveChapter).not.toHaveBeenCalled();
    await act(async () => {
      body.querySelector('p')!.textContent = '中文完成';
      body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文完成' }));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(await session.flush()).toBe(true);
    });
    expect(documentText(saveChapter.mock.results.length ? session.getSnapshot().chapter! : chapter)).toBe('中文完成');
    expect(body.textContent).toBe('中文完成'); expect(saveChapter).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); container.remove(); session.dispose(); }
});
