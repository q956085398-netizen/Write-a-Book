// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { readDocument, writeDocument, richExtensions, documentText } from './rich-content';
import { EditorSession } from './editor-session';
import type { Chapter, SaveChapter } from './model';
const editors: Editor[] = [];
const sessions: EditorSession[] = [];
afterEach(() => { editors.splice(0).forEach(e => e.destroy()); sessions.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); });
const base: Chapter = { id: 'chapter', contentId: 'content', workId: 'work', title: '第一章', body: '', bodyFormat: 'plain-text', revision: 0 };
function edit(chapter = base) {
  const saved: Chapter[] = [];
  const session = new EditorSession({ checkpointChapter: async () => {}, acknowledgeRecovery: async () => {}, saveChapter: async (draft: SaveChapter) => { const receipt = { ...chapter, ...draft, revision: draft.expectedRevision + 1 }; saved.push(receipt); return receipt; } });
  session.load(chapter); sessions.push(session);
  const editor = new Editor({ element: document.createElement('div'), extensions: richExtensions(), content: readDocument(chapter), enableInputRules: false,
    onUpdate: ({ editor }) => session.editDocument(writeDocument(editor.getJSON())) });
  editors.push(editor); return { editor, session, saved };
}
it('keeps JSON-looking legacy text literal and does not migrate on mere open', async () => {
  const body = '{"format":"write-a-book","version":1,"doc":{"type":"doc"}}\n<tag>中文 & 原文</tag>\n\n';
  const { editor, session, saved } = edit({ ...base, body });
  expect(editor.getText()).toContain('<tag>中文 & 原文</tag>');
  expect(editor.state.doc.firstChild?.textContent).toBe(body.split('\n')[0]);
  await session.flush(); expect(saved).toHaveLength(0);
  expect(session.getSnapshot().chapter?.body).toBe(body);
});
it('round trips headings, marks, lists, quote, link and managed image through acknowledged persistence', async () => {
  const { editor, session, saved } = edit();
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '章节小标题' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '粗斜体下划线', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }] }, { type: 'text', text: '链接', marks: [{ type: 'link', attrs: { href: 'HTTPS://example.com/CaseSensitive?Token=Aa' } }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '无序' }] }] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '有序' }] }] }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用' }] }] },
    { type: 'managedImage', attrs: { attachmentId: '12345678-1234-1234-1234-123456789abc', alt: '插图' } },
  ] };
  editor.commands.setContent(doc); await session.flush();
  expect(saved[0].bodyFormat).toBe('wab-rich-v1');
  const restored = edit(saved[0]).editor;
  expect(restored.getJSON()).toEqual(editor.getJSON());
  expect(restored.getHTML()).toContain('<strong><em><u>');
  expect(documentText(saved[0])).toContain('引用');
  expect(documentText(saved[0])).not.toContain('12345678');
});
it('preserves selection and undo after persistence during a 100000-character manuscript with 20 images', async () => {
  const { editor, session, saved } = edit();
  const text = '中文连续写作。'.repeat(14286);
  editor.commands.setContent({ type: 'doc', content: Array.from({ length: 200 }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: text.slice(index * 500, (index + 1) * 500) }] })) });
  for (let n = 0; n < 20; n++) editor.commands.insertContent({ type: 'managedImage', attrs: { attachmentId: '12345678-1234-1234-1234-123456789abc', alt: '图' } });
  await session.flush();
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent('追加中文');
  const selection = editor.state.selection.from;
  await session.flush();
  expect(editor.state.selection.from).toBe(selection);
  expect(documentText(saved.at(-1)!)).toContain('追加中文');
  expect(editor.commands.undo()).toBe(true);
  expect(editor.getText()).not.toContain('追加中文');
  expect(editor.commands.redo()).toBe(true);
  expect(editor.getText()).toContain('追加中文');
});
it('rejects unsupported versions and unknown nodes without rewriting input', () => {
  expect(() => readDocument({ bodyFormat: 'future', body: '原始内容' })).toThrow();
  expect(() => readDocument({ bodyFormat: 'wab-rich-v1', body: writeDocument({ type: 'doc', content: [{ type: 'unknown' }] }) })).toThrow();
  expect(() => readDocument({ bodyFormat: 'wab-rich-v1', body: '{broken' })).toThrow();
});
it('waits for image import before the close snapshot and never acknowledges only its earlier text', async () => {
  const { editor, session, saved } = edit();
  let complete!: () => void;
  const task = new Promise<void>(resolve => { complete = resolve; }).then(() => { editor.commands.insertContent('图片后文字'); });
  session.trackAttachment(task);
  const closing = session.flush();
  await Promise.resolve(); expect(saved).toHaveLength(0);
  complete(); expect(await closing).toBe(true);
  expect(documentText(saved[0])).toContain('图片后文字');
});

it('copies managed image identity within the same content without persisting data URLs or external image sources', () => {
  const { editor } = edit();
  editor.commands.insertContent('<span data-attachment-id="12345678-1234-1234-1234-123456789abc">插图</span><img src="file:///C:/private.png"><img src="https://example.com/tracker.png">');
  const body = writeDocument(editor.getJSON());
  expect(body).toContain('12345678-1234-1234-1234-123456789abc');
  expect(body).not.toContain('file:'); expect(body).not.toContain('https:');
});
