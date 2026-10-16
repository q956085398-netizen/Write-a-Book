import { Node, getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Chapter } from './model';

export const ManagedImage = Node.create({
  name: 'managedImage', group: 'block', atom: true, draggable: false,
  addAttributes: () => ({ attachmentId: { default: null }, alt: { default: '' } }),
  // External HTML cannot introduce filesystem or network images into the document.
  parseHTML: () => [{ tag: 'span[data-attachment-id]', getAttrs: element => {
    const id = element.getAttribute('data-attachment-id') ?? '';
    return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? { attachmentId: id, alt: element.textContent ?? '' } : false;
  } }],
  renderHTML: ({ node }) => ['span', { 'data-attachment-id': node.attrs.attachmentId }, node.attrs.alt || '图片'],
});
export const richExtensions = (image = ManagedImage) => [StarterKit.configure({
  code: false, codeBlock: false, strike: false, horizontalRule: false,
  heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: false, linkOnPaste: false },
}), image];
const schema = getSchema(richExtensions());
export function readDocument(chapter: Pick<Chapter, 'body' | 'bodyFormat'>): JSONContent {
  if (!chapter.bodyFormat || chapter.bodyFormat === 'plain-text') {
    return { type: 'doc', content: chapter.body.split(/\r?\n/).map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })) };
  }
  if (chapter.bodyFormat !== 'wab-rich-v1') throw new Error('正文格式来自其他版本，请保留原文并使用对应版本打开。');
  const value = JSON.parse(chapter.body);
  if (Object.keys(value).some(key => !['format','version','doc'].includes(key)) || value.format !== 'write-a-book' || value.version !== 1 || value.doc?.type !== 'doc') throw new Error('图文内容版本无效，原文已保留。');
  const node = schema.nodeFromJSON(value.doc);
  node.check();
  // Prevent silently dropping unknown attributes or node data on the first edit.
  const inspect = (raw: JSONContent, depth = 0) => {
    if (depth > 64) throw new Error('图文层级过深，原文已保留。');
    const spec = schema.nodes[raw.type ?? ''];
    if (!spec || Object.keys(raw).some(key => !['type','attrs','content','marks','text'].includes(key))) throw new Error('图文含不支持的内容。');
    for (const key of Object.keys(raw.attrs ?? {})) if (!(key in (spec.spec.attrs ?? {}))) throw new Error('图文含不支持的属性。');
    for (const mark of raw.marks ?? []) {
      const markSpec = schema.marks[mark.type];
      if (!markSpec || Object.keys(mark.attrs ?? {}).some(key => !(key in (markSpec.spec.attrs ?? {})))) throw new Error('图文含不支持的格式。');
      if (mark.type === 'link' && !safeLink(mark.attrs?.href)) throw new Error('正文含不支持的链接。');
    }
    if (raw.type === 'managedImage' && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw.attrs?.attachmentId ?? '')) throw new Error('图片身份无效。');
    raw.content?.forEach(child => inspect(child, depth + 1));
  };
  inspect(value.doc);
  return value.doc;
}
export const writeDocument = (doc: JSONContent): string => JSON.stringify({ format: 'write-a-book', version: 1, doc });
export const safeLink = (href: unknown): href is string => typeof href === 'string' && /^(https?:\/\/|mailto:)/i.test(href);
export function documentText(chapter: Pick<Chapter, 'body' | 'bodyFormat'>): string {
  if (!chapter.bodyFormat || chapter.bodyFormat === 'plain-text') return chapter.body;
  try { const doc = schema.nodeFromJSON(readDocument(chapter)); return doc.textBetween(0, doc.content.size, '\n'); }
  catch { return ''; }
}
