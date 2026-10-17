import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { application } from './application';
import { characterCount } from './model';
import type { EditorCharacterCounts } from './character-count';
import type { Chapter } from './model';
import { errorText } from './model';
import type { EditorSession } from './editor-session';
import { ManagedImage, readDocument, richExtensions, safeLink, writeDocument } from './rich-content';

export function RichEditor(props: { chapter: Chapter; session: EditorSession; disabled: boolean; label?: string; onCharacterCountsChange?: (counts: EditorCharacterCounts | null) => void }) {
  return <InitialEditor key={props.chapter.contentId} {...props}/>;
}
function InitialEditor(props: Parameters<typeof RichEditor>[0]) {
  const [initial] = useState(() => { try { return { doc: readDocument(props.chapter), error: '' }; } catch (error) { return { doc: null, error: errorText(error) }; } });
  return initial.doc ? <Editable {...props} initial={initial.doc}/> : <div className="content-error" role="alert"><p>{initial.error} 请先复制原文；本页不会将无法识别的内容替换为空白。</p><textarea aria-label="保留的原始正文" readOnly value={props.chapter.body}/></div>;
}
function Editable({ chapter, session, disabled, initial, label, onCharacterCountsChange }: Parameters<typeof RichEditor>[0] & { initial: ReturnType<typeof readDocument> }) {
  const countCallback = useRef(onCharacterCountsChange);
  countCallback.current = onCharacterCountsChange;
  function reportCounts(editor: Editor) {
    const { from, to } = editor.state.selection;
    countCallback.current?.({ contentId: chapter.contentId, current: characterCount(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')), selection: characterCount(editor.state.doc.textBetween(from, to, '\n')) });
  }
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const currentEditor = useRef<Editor | null>(null);
  const alive = useRef(true);
  const importBusy = useRef(false);
  const [imageNode] = useState(() => ManagedImage.extend({
    addNodeView() { return ({ node }) => {
      const dom = document.createElement('figure'); dom.className = 'managed-image'; dom.contentEditable = 'false';
      const label = document.createElement('span'); label.textContent = '图片读取中…'; dom.append(label);
      let cancelled = false;
      void application.readImage(chapter.contentId, node.attrs.attachmentId).then(src => {
        if (cancelled) return;
        const img = document.createElement('img'); img.src = src; img.alt = node.attrs.alt || '资料库图片';
        img.addEventListener('error', () => { label.textContent = '图片无法显示，正文仍保留。'; dom.replaceChildren(label); });
        dom.replaceChildren(img);
      }).catch(cause => { if (!cancelled) { label.textContent = errorText(cause); dom.classList.add('image-error'); } });
      return { dom, destroy: () => { cancelled = true; } };
    }; },
  }));
  async function importFiles(files: File[]) {
    const editor = currentEditor.current;
    if (!editor || importBusy.current || disabled || editor.view.composing) return;
    importBusy.current = true; setImporting(true); setError(''); editor.setEditable(false, false);
    const task = (async () => {
      // Import each file fully before changing the document. The close/switch barrier waits here.
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，尚未插入。');
        const attachment = await application.importImage(chapter.contentId, file.name, Array.from(new Uint8Array(await file.arrayBuffer())));
        if (editor.isDestroyed) throw new Error('编辑已结束，图片已归入资料库但未插入正文。');
        editor.chain().insertContent({ type: 'managedImage', attrs: { attachmentId: attachment.id, alt: attachment.name } }).run();
      }
    })();
    try { await session.trackAttachment(task); }
    catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { importBusy.current = false; if (!editor.isDestroyed) editor.setEditable(!disabled, false); if (alive.current) { setImporting(false); editor.commands.focus(); } }
  }
  const editor = useEditor({
    extensions: richExtensions(imageNode), content: initial, enableInputRules: false, enablePasteRules: false,
    immediatelyRender: true, shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { id: 'chapter-body', class: 'chapter-body', role: 'textbox', 'aria-label': label ?? '章节正文', 'aria-multiline': 'true', spellcheck: 'false' },
      handleDOMEvents: {
        compositionstart: () => { session.beginComposition(); return false; },
        compositionend: () => { setTimeout(() => { if (currentEditor.current && !currentEditor.current.isDestroyed) session.editDocument(writeDocument(currentEditor.current.getJSON())); session.endComposition(); }, 0); return false; },
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) { event.preventDefault(); void importFiles(files); return true; }
        if (event.clipboardData?.getData('text/html').includes('<img')) setError('外部网页图片未导入；请复制图片本身或使用“图片”选择本地文件。');
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) { event.preventDefault(); void importFiles(files); return true; }
        return false;
      },
    },
    onUpdate: ({ editor }) => session.editDocument(writeDocument(editor.getJSON())),
    onTransaction: ({ editor }) => reportCounts(editor),
  });
  currentEditor.current = editor;
  useEffect(() => { if (editor) reportCounts(editor); return () => { countCallback.current?.(null); }; }, [editor]);
  useEffect(() => { editor?.setEditable(!disabled && !importing, false); }, [editor, disabled, importing]);
  useEffect(() => { if (editor) editor.view.dom.setAttribute('aria-label', label ?? '章节正文'); }, [editor, label]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!editor) return null;
  const blocked = disabled || importing;
  const button = (label: string, action: () => void, active = false, available = true) => <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={blocked || !available} onMouseDown={event => event.preventDefault()} onClick={action}>{label}</button>;
  return <>
    <div className="format-toolbar" role="toolbar" aria-label="正文格式">
      {button('正文', () => { editor.chain().focus().setParagraph().run(); }, editor.isActive('paragraph'))}
      {[1, 2, 3].map(level => <button key={level} type="button" title={`标题 ${level}`} aria-label={`标题 ${level}`} aria-pressed={editor.isActive('heading', { level })} disabled={blocked} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run()}>H{level}</button>)}
      {button('粗体', () => { editor.chain().focus().toggleBold().run(); }, editor.isActive('bold'))}
      {button('斜体', () => { editor.chain().focus().toggleItalic().run(); }, editor.isActive('italic'))}
      {button('下划线', () => { editor.chain().focus().toggleUnderline().run(); }, editor.isActive('underline'))}
      {button('无序列表', () => { editor.chain().focus().toggleBulletList().run(); }, editor.isActive('bulletList'))}
      {button('有序列表', () => { editor.chain().focus().toggleOrderedList().run(); }, editor.isActive('orderedList'))}
      {button('引用', () => { editor.chain().focus().toggleBlockquote().run(); }, editor.isActive('blockquote'))}
      {button('链接', () => { setLink(editor.getAttributes('link').href ?? ''); setLinkOpen(!linkOpen); }, editor.isActive('link'))}
      {button('图片', () => fileInput.current?.click())}
      {button('撤销', () => { editor.chain().focus().undo().run(); }, false, editor.can().undo())}
      {button('重做', () => { editor.chain().focus().redo().run(); }, false, editor.can().redo())}
    </div>
    {linkOpen && <form className="link-form" onSubmit={event => { event.preventDefault(); if (!safeLink(link)) { setError('请输入 http、https 或 mailto 链接。'); return; } editor.chain().focus().extendMarkRange('link').setLink({ href: link }).run(); setLinkOpen(false); setError(''); }}><label>链接地址<input autoFocus value={link} onChange={event => setLink(event.target.value)} placeholder="https://"/></label><button disabled={blocked}>应用链接</button><button type="button" disabled={blocked} onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkOpen(false); }}>移除链接</button><button type="button" onClick={() => setLinkOpen(false)}>取消</button></form>}
    {importing && <p className="editor-notice" role="status">正在将图片保存到资料库…</p>}
    {error && <div className="editor-notice" role="alert">{error}<button onClick={() => setError('')}>知道了</button></div>}
    <input type="file" ref={fileInput} className="sr-only" aria-label="选择图片" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files); }}/>
    <EditorContent editor={editor}/>
  </>;
}
