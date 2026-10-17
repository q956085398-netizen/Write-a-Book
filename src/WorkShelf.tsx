import type { Work } from './model';

export function WorkShelf({ works, mode, busy, onMode, onSelect, onCreate }: {
  works: Work[]; mode: 'shelf' | 'list'; busy: boolean;
  onMode: (mode: 'shelf' | 'list') => void; onSelect: (id: string) => void; onCreate: () => void;
}) {
  return <section className="works-home" aria-label="作品书架">
    <div className="works-heading"><div><span className="eyebrow">本地资料库</span><h1>作品</h1><p>回到上次写下的地方，或给新的故事留个位置。</p></div>
      <div className="view-switch" aria-label="作品显示方式"><button aria-pressed={mode === 'shelf'} onClick={() => onMode('shelf')}>书架</button><button aria-pressed={mode === 'list'} onClick={() => onMode('list')}>紧凑列表</button></div>
    </div>
    <div className={'works-collection ' + mode}>
      {works.map(work => <article className="work-card" key={work.id}>
        <div className="type-cover" aria-hidden="true"><span>创作作品</span><strong>{work.title}</strong><i>书</i></div>
        <div className="work-card-info"><h2>{work.title}</h2><p>继续位置：{work.lastEntry ? `${work.lastEntry.kind === 'fragment' ? '未编章片段' : '章节'} · ${work.lastEntry.title || '未命名'}` : '暂无继续位置'}</p></div>
        <button className="primary" disabled={busy} aria-label={`继续创作 ${work.title}`} onClick={() => onSelect(work.id)}>继续创作<span className="sr-only"> {work.title}</span></button>
      </article>)}
      <button className="new-work-card" disabled={busy} onClick={onCreate}><span aria-hidden="true">＋</span><strong>新建作品</strong><small>先取个暂名，就能开始写。</small></button>
    </div>
  </section>;
}
