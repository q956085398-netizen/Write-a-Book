import { useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { ManagedImage, readDocument, richExtensions } from '../rich-content';
import { errorText } from '../model';
import type { ConceptionPort, ConceptionRecord, SaveConception } from './types';

type Content = Pick<ConceptionRecord | SaveConception, 'body' | 'bodyFormat' | 'contentId'>;
export function ConceptionPreview({ content, label, port }: { content: Content; label: string; port: ConceptionPort }) {
  const [parsed] = useState(() => { try { return {doc:readDocument(content),error:''}; } catch (error) { return {doc:null,error:errorText(error)}; } });
  if (!parsed.doc) return <div className="conception-preview"><p role="alert">{parsed.error} 原始构思只读保留。</p><textarea readOnly aria-label={label} value={content.body}/></div>;
  return <Readable content={content} label={label} port={port} initial={parsed.doc}/>;
}
function Readable({ content, label, port, initial }: { content: Content; label: string; port: ConceptionPort; initial: ReturnType<typeof readDocument> }) {
  const [image] = useState(() => ManagedImage.extend({ addNodeView() { return ({node}) => {
    const dom=document.createElement('figure'); dom.className='managed-image';
    const status=document.createElement('span'); status.textContent='图片读取中…'; dom.append(status);
    let cancelled=false;
    void port.readImage(content.contentId,node.attrs.attachmentId).then(src => {
      if (cancelled) return;
      const img=document.createElement('img'); img.src=src; img.alt=node.attrs.alt || '构思图片';
      img.addEventListener('error',() => {status.textContent='图片无法显示，文字仍保留。';dom.replaceChildren(status);});
      dom.replaceChildren(img);
    }).catch(error => {if (!cancelled) status.textContent=errorText(error);});
    return {dom,destroy:() => {cancelled=true;}};
  }; } }));
  const editor=useEditor({extensions:richExtensions(image),content:initial,editable:false,immediatelyRender:true,
    editorProps:{attributes:{class:'chapter-body',role:'document','aria-label':label}}});
  return <div className="conception-preview"><EditorContent editor={editor}/></div>;
}
