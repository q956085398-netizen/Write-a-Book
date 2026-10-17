import type { Entry, Volume } from './model';

export type StructureIntent = { type: 'createChapter' | 'createFragment' | 'createVolume' | 'renameVolume' | 'move' | 'compileFragment'; id?: string };
export type OutlineItem = { id: string; title: string; position: number; isVolume: boolean };
export function outlineItems(entries: Entry[], volumes: Volume[], parent: string | null): OutlineItem[] {
  return [...entries.filter(entry => entry.kind === 'chapter' && entry.volumeId === parent).map(entry => ({ ...entry, isVolume: false })),
    ...(parent === null ? volumes.map(volume => ({ ...volume, isVolume: true })) : [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}
export function WritingDirectory({ entries, volumes, activeId, busy, onSelect, onIntent, onMove }: {
  entries: Entry[]; volumes: Volume[]; activeId: string; busy: boolean;
  onSelect: (id: string) => void; onIntent: (intent: StructureIntent) => void;
  onMove: (id: string, volumeId: string | null, beforeId: string | null) => void;
}) {
  function row(item: OutlineItem, items: OutlineItem[], parent: string | null, index: number) {
    function shift(delta: number) {
      const reordered = [...items]; const [moving] = reordered.splice(index, 1); reordered.splice(index + delta, 0, moving);
      onMove(item.id, parent, reordered[index + delta + 1]?.id ?? null);
    }
    return <div className={'outline-row ' + (item.id === activeId ? 'selected' : '')} key={item.id}>
      {item.isVolume ? <strong className="volume-name">{item.title || '未命名卷'}</strong> : <button className="entry-name" disabled={busy} aria-current={item.id === activeId ? 'page' : undefined} onClick={() => onSelect(item.id)}>{item.title || '未命名章节'}</button>}
      <div className="outline-actions">
        <button disabled={busy || index === 0} aria-label={`上移 ${item.title}`} title="上移" onClick={() => shift(-1)}>↑</button>
        <button disabled={busy || index === items.length - 1} aria-label={`下移 ${item.title}`} title="下移" onClick={() => shift(1)}>↓</button>
        <button disabled={busy} aria-label={`整理 ${item.title}`} title="调整位置" onClick={() => onIntent({ type: 'move', id: item.id })}>⋯</button>
        {item.isVolume && <button disabled={busy} aria-label={`改名 ${item.title}`} title="修改卷名" onClick={() => onIntent({ type: 'renameVolume', id: item.id })}>改名</button>}
      </div>
    </div>;
  }
  const roots = outlineItems(entries, volumes, null);
  const fragments = entries.filter(entry => entry.kind === 'fragment').sort((a, b) => a.position - b.position);
  return <div className="writing-directory" aria-label="写作目录">
    <div className="section-heading"><span>写作目录</span><span>{entries.filter(entry => entry.kind === 'chapter').length} 章</span></div>
    <nav aria-label="卷章目录">{roots.map((item, index) => item.isVolume ? <div className="volume-group" key={item.id}>
      {row(item, roots, null, index)}
      <div className="volume-children">{outlineItems(entries, volumes, item.id).map((child, childIndex, siblings) => row(child, siblings, item.id, childIndex))}
        {!entries.some(entry => entry.volumeId === item.id) && <p className="directory-empty">本卷暂无章节</p>}
      </div>
    </div> : row(item, roots, null, index))}</nav>
    <div className="directory-create"><button disabled={busy} onClick={() => onIntent({ type: 'createChapter' })}>＋ 新建章节</button><button disabled={busy} onClick={() => onIntent({ type: 'createVolume' })}>＋ 新建分卷</button></div>
    <div className="fragment-heading">未编章片段 <span>{fragments.length} 篇</span></div>
    <nav aria-label="未编章片段">{fragments.map(fragment => <div className={'outline-row fragment-row ' + (fragment.id === activeId ? 'selected' : '')} key={fragment.id}>
      <button className="entry-name" disabled={busy} aria-current={fragment.id === activeId ? 'page' : undefined} onClick={() => onSelect(fragment.id)}>{fragment.title || '未命名片段'}</button>
      <button className="compile-entry" disabled={busy} aria-label={`编为新章节 ${fragment.title}`} onClick={() => onIntent({ type: 'compileFragment', id: fragment.id })}>编章</button>
    </div>)}</nav>
    {!fragments.length && <p className="directory-empty">先写下想到的正文，再安排章节。</p>}
    <div className="directory-create"><button disabled={busy} onClick={() => onIntent({ type: 'createFragment' })}>＋ 新建片段</button></div>
  </div>;
}
