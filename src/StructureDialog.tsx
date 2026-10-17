import { useEffect, useRef, useState } from 'react';
import type { Entry, StructureChange, Volume } from './model';
import { outlineItems, type StructureIntent } from './WritingDirectory';

export function StructureDialog({ intent, workId, revision, entries, volumes, busy, error, onCancel, onConfirm }: {
  intent: StructureIntent; workId: string; revision: number; entries: Entry[]; volumes: Volume[]; busy: boolean; error: string | null;
  onCancel: () => void; onConfirm: (change: StructureChange) => void;
}) {
  const source = entries.find(entry => entry.id === intent.id);
  const volume = volumes.find(item => item.id === intent.id);
  const [title, setTitle] = useState(volume?.title ?? '');
  const [parent, setParent] = useState(source?.volumeId ?? '');
  const [before, setBefore] = useState('');
  const [composing, setComposing] = useState(false);
  const host = useRef<HTMLElement>(null);
  const compile = intent.type === 'compileFragment';
  const moving = compile || intent.type === 'move';
  const entryCreating = intent.type === 'createChapter' || intent.type === 'createFragment';
  const heading = { createChapter: '新建章节', createFragment: '新建正文片段', createVolume: '新建分卷', renameVolume: '修改卷名', move: '调整目录位置', compileFragment: '编为新章节' }[intent.type];
  const showParent = !volume && (moving || intent.type === 'createChapter');
  const siblings = outlineItems(entries, volumes, parent || null).filter(item => item.id !== intent.id);
  useEffect(() => { host.current?.querySelector<HTMLElement>('input:not([readonly]),select,button')?.focus(); }, []);
  function confirm() {
    if (busy || composing) return;
    const base = { workId, expectedRevision: revision };
    if (moving) onConfirm({ ...base, type: compile ? 'compileFragment' : 'move', id: intent.id!, volumeId: parent || null, beforeId: before || null });
    else if (entryCreating) onConfirm({ ...base, type: 'createEntry', kind: intent.type === 'createFragment' ? 'fragment' : 'chapter', title, volumeId: intent.type === 'createFragment' ? null : parent || null });
    else if (intent.type === 'renameVolume') onConfirm({ ...base, type: 'renameVolume', id: intent.id!, title });
    else onConfirm({ ...base, type: 'createVolume', title });
  }
  return <div className="structure-overlay"><section className="structure-dialog" role="dialog" aria-modal="true" aria-labelledby="structure-heading" ref={host}
    onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
    onMouseDownCapture={event => { if (composing && event.target instanceof Element && event.target.closest('button')) event.preventDefault(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && !composing && !busy) onCancel();
      if (event.key !== 'Tab') return;
      const items = Array.from(host.current?.querySelectorAll<HTMLElement>('input:not([readonly]):not(:disabled),select:not(:disabled),button:not(:disabled)') ?? []);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <h2 id="structure-heading">{heading}</h2>
    {compile ? <p className="structure-explanation">这份片段会成为一个新章节，从“未编章片段”移出。原有文字与图片完整保留，不会留下重复正文。</p> : moving ? <p className="structure-explanation">调整{volume ? '分卷' : '章节'}在当前作品中的位置，正文保持原样。</p> : <p className="structure-explanation">{intent.type === 'createFragment' ? '片段独立保存，可以先写正文，以后再编为新章节。' : intent.type === 'createVolume' ? '分卷是可选的，也可以直接在目录顶层写章节。' : '名称可以暂定，之后仍可修改。'}</p>}
    <form onSubmit={event => { event.preventDefault(); confirm(); }}>
      {moving ? <div className="structure-source"><span>{compile ? '沿用片段名称' : '正在整理'}</span><strong>{source?.title || volume?.title || '未命名'}</strong></div> : <label htmlFor="structure-title">{entryCreating ? (intent.type === 'createFragment' ? '片段名称' : '章节名称') : '分卷名称'}<input id="structure-title" value={title} disabled={busy} placeholder="可以暂不命名" onChange={event => setTitle(event.target.value)}/></label>}
      {showParent && <label htmlFor="structure-parent">所属位置<select id="structure-parent" value={parent} disabled={busy} onChange={event => { setParent(event.target.value); setBefore(''); }}><option value="">目录顶层（不分卷）</option>{volumes.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}
      {moving && <label htmlFor="structure-before">插入位置<select id="structure-before" value={before} disabled={busy} onChange={event => setBefore(event.target.value)}><option value="">{parent ? '本卷末尾' : '目录末尾'}</option>{siblings.map(item => <option value={item.id} key={item.id}>在{item.isVolume ? '分卷' : '章节'}“{item.title || '未命名'}”之前</option>)}</select></label>}
      {error && <p role="alert" className="structure-error">{error}</p>}
      <div className="form-actions"><button type="button" disabled={busy || composing} onClick={onCancel}>取消</button><button className="primary" type="submit" disabled={busy || composing}>{busy ? '正在保存…' : compile ? '确认编为新章节' : moving ? '确认移动' : '保存并继续'}</button></div>
    </form>
  </section></div>;
}
