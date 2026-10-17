// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import { expect, it, vi } from 'vitest';
import { RichEditor } from '../RichEditor';
import { EditorSession } from '../editor-session';
import { richExtensions, writeDocument } from '../rich-content';
import { CharacterCountFooter } from './CharacterCountFooter';
import type { EditorCharacterCounts } from './index';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../application', () => ({ application: { readImage: vi.fn().mockRejectedValue(new Error('missing')), importImage: vi.fn() } }));
it('reports cross-paragraph selection excluding image alt, edits and undo; keeps current values on aggregate failure', async () => {
  const chapter = { id: 'a', contentId: 'a', workId: 'w', title: '标题不算', revision: 0, bodyFormat: 'wab-rich-v1', body: writeDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '中文，' }] }, { type: 'managedImage', attrs: { attachmentId: '12345678-1234-1234-1234-123456789abc', alt: '图片不算' } }, { type: 'paragraph', content: [{ type: 'text', text: 'A!🙂' }] }] }) };
  const session = new EditorSession({ saveChapter: async draft => ({ ...chapter, ...draft, revision: 1 }), checkpointChapter: async () => {}, acknowledgeRecovery: async () => {} }); session.load(chapter);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  let latest: EditorCharacterCounts | null = null;
  const onCounts = (value: EditorCharacterCounts | null) => { latest = value; };
  try {
    await act(async () => root.render(<RichEditor chapter={chapter} session={session} disabled={false} onCharacterCountsChange={onCounts}/>));
    const dom = container.querySelector('.tiptap') as HTMLElement & { editor?: Editor };
    // Tiptap exposes its editor on the editable DOM node.
    const editor = dom.editor!;
    expect(latest).toEqual({ contentId: 'a', current: 6, selection: 0 });
    await act(async () => { editor.commands.selectAll(); });
    expect(latest).toEqual({ contentId: 'a', current: 6, selection: 6 });
    await act(async () => { editor.commands.setTextSelection(1); editor.commands.insertContent('增'); });
    expect(latest).toMatchObject({ current: 7 });
    await act(async () => { editor.commands.undo(); });
    expect(latest).toMatchObject({ current: 6 });
    const nextChapter = { ...chapter, id: 'b', contentId: 'b', body: '新章', bodyFormat: 'plain-text' };
    session.load(nextChapter);
    await act(async () => root.render(<RichEditor chapter={nextChapter} session={session} disabled={false} onCharacterCountsChange={onCounts}/>));
    expect(latest).toEqual({ contentId: 'b', current: 2, selection: 0 });
    expect(container.querySelector('#chapter-body')?.textContent).toBe('新章');
    await act(async () => root.render(<CharacterCountFooter counts={null} live={latest} kind="chapter"/>));
    expect(container.textContent).toContain('当前章节 2');
    expect(container.textContent).toContain('全书章节 暂不可用');
  } finally { await act(async () => root.unmount()); container.remove(); session.dispose(); }
});
it('selection text uses no image alt through the standard schema', () => {
  const editor = new Editor({ extensions: richExtensions(), content: '<p>中 A!</p><p>文🙂</p>' });
  editor.commands.selectAll();
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')).toBe('中 A!\n文🙂');
  editor.destroy();
});
