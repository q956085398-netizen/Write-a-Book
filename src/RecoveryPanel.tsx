import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import { application } from './application';
import { characterCount, errorText, type Chapter, type RecoveryCandidate } from './model';
import { documentText, readDocument } from './rich-content';
import './RecoveryPanel.css';

type PreviewContent = Pick<Chapter, 'contentId' | 'title' | 'body' | 'bodyFormat'>;
function ManagedPreviewImage({ contentId, attachmentId, alt }: { contentId: string; attachmentId: string; alt: string }) {
  const [result, setResult] = useState<{ key: string; src?: string; error?: string } | null>(null);
  const key = `${contentId}/${attachmentId}`;
  useEffect(() => {
    let active = true;
    setResult(null);
    void application.readImage(contentId, attachmentId).then(src => { if (active) setResult({ key, src }); })
      .catch(cause => { if (active) setResult({ key, error: errorText(cause) }); });
    return () => { active = false; };
  }, [contentId, attachmentId]);
  const current = result?.key === key ? result : null;
  return <figure className="managed-image recovery-image">
    {current?.src ? <img src={current.src} alt={alt || '资料库图片'} onError={() => setResult({ key, error: '图片无法显示，正文与图片记录仍保留。' })}/> :
      <span className={current?.error ? 'image-error' : ''}>{current?.error || '图片读取中…'}{alt && `（${alt}）`}</span>}
  </figure>;
}
function renderNode(node: JSONContent, contentId: string, path: string): ReactNode {
  const children = node.content?.map((child, index) => <Fragment key={`${path}.${index}`}>{renderNode(child, contentId, `${path}.${index}`)}</Fragment>);
  if (node.type === 'text') {
    let text: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = <strong>{text}</strong>;
      if (mark.type === 'italic') text = <em>{text}</em>;
      if (mark.type === 'underline') text = <u>{text}</u>;
      if (mark.type === 'link') text = <a href={mark.attrs?.href} target="_blank" rel="noreferrer">{text}</a>;
    }
    return text;
  }
  switch (node.type) {
    case 'doc': return children;
    case 'paragraph': return <p>{children || <br/>}</p>;
    case 'heading': return node.attrs?.level === 1 ? <h3>{children}</h3> : node.attrs?.level === 2 ? <h4>{children}</h4> : <h5>{children}</h5>;
    case 'bulletList': return <ul>{children}</ul>;
    case 'orderedList': return <ol start={node.attrs?.start ?? 1}>{children}</ol>;
    case 'listItem': return <li>{children}</li>;
    case 'blockquote': return <blockquote>{children}</blockquote>;
    case 'hardBreak': return <br/>;
    case 'managedImage': return <ManagedPreviewImage contentId={contentId} attachmentId={node.attrs!.attachmentId} alt={node.attrs?.alt ?? ''}/>;
    default: return null; // readDocument rejects unsupported nodes before this renderer is used.
  }
}
export function RecoveryPreview({ content, label }: { content: PreviewContent; label: string }) {
  const parsed = useMemo(() => {
    try { return { doc: readDocument(content), error: null }; }
    catch (cause) { return { doc: null, error: errorText(cause) }; }
  }, [content.body, content.bodyFormat]);
  return <section className="recovery-preview" aria-label={label}>
    <h3 className="recovery-document-title">{content.title || '未命名正文'}</h3>
    {parsed.doc ? <div className="recovery-document">{renderNode(parsed.doc, content.contentId, 'doc')}</div> : <div className="content-error">
      <p>{parsed.error} 原文仅供查看与复制，未作转换。</p>
      <textarea aria-label={`${label}原始正文（全文）`} readOnly value={content.body}/>
    </div>}
    {parsed.doc && <p className="recovery-word-count">字数（含标点） {characterCount(documentText(content))} · 正文全文，可滚动查看与复制</p>}
  </section>;
}
function readable(content: PreviewContent) { try { readDocument(content); return true; } catch { return false; } }
function differs(left: PreviewContent | null, right: PreviewContent) {
  return !left || left.contentId !== right.contentId || left.title !== right.title || left.body !== right.body || left.bodyFormat !== right.bodyFormat;
}
export function RecoveryPanel({ current, currentStatus, candidates, error, busy, onRefresh, onReturn, onRecover }: {
  current: Chapter | null; currentStatus?: string; candidates: RecoveryCandidate[]; error: string | null; busy: boolean;
  onRefresh: () => void; onReturn: () => void; onRecover: (candidate: RecoveryCandidate, asCopy: boolean) => void;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const selected = candidates.find(candidate => candidate.id === selection) ?? candidates[0];
  const supported = selected ? readable(selected.draft) : false;
  const complete = !!selected && !selected.integrityError && supported;
  return <section className="recovery-panel" aria-labelledby="recovery-heading">
    <header className="recovery-heading"><div><button disabled={busy} onClick={onReturn}>← 返回正文</button>
      <h1 id="recovery-heading">恢复记录</h1><p>先对比完整内容，再选择恢复方式。不会自动应用草稿。</p></div>
      <button disabled={busy} onClick={onRefresh}>刷新恢复记录</button></header>
    {error && <div className="recovery-error" role="alert">{error}<br/>恢复未完成时，当前内容与原恢复记录继续保留。请刷新后核对。</div>}
    <div className="recovery-columns">
      <div className="recovery-current"><h2>当前窗口内容</h2>{currentStatus && <span className="recovery-tag">{currentStatus}</span>}
        <p className="recovery-caption">{current ? '保留进入恢复页时的完整内容。可查看与复制，恢复选择由你确认。' : '当前窗口没有打开正文。'}</p>
        {current && <RecoveryPreview content={current} label="当前窗口正文全文"/>}
        {selected && (!selected.current || differs(current, selected.current)) && <div className="recovery-saved-version">
          <h2>此记录对应的资料库当前版本</h2>
          {selected.current ? <RecoveryPreview content={selected.current} label="资料库当前版本全文"/> : <p>无法读取当前版本。原恢复草稿保留，仅可在完整性确认后另存。</p>}
        </div>}
      </div>
      <div className="recovery-drafts"><h2>本地恢复草稿 <span className="recovery-count">{candidates.length}</span></h2>
        <p className="recovery-caption">各编辑会话已留存的快照；序号只表示同一会话内的顺序。</p>
        {candidates.length === 0 && <p className="recovery-empty">{error ? '暂时无法读取恢复记录，请保留资料库并重试。' : '没有需要处理的恢复草稿。'}</p>}
        <div className="recovery-list" aria-label="选择恢复草稿">
          {candidates.map((candidate, index) => {
            const valid = !candidate.integrityError && readable(candidate.draft);
            return <button key={candidate.id} className={'recovery-record'+(selected?.id === candidate.id ? ' selected' : '')}
              aria-pressed={selected?.id === candidate.id} disabled={busy} onClick={() => setSelection(candidate.id)}>
              <span className="recovery-record-title">{candidate.draft.title || '未命名正文'} · 草稿 {index + 1}</span>
              <span className="recovery-tags"><span className={'recovery-tag '+(valid ? 'complete' : 'invalid')}>{valid ? '完整性已确认' : '完整性未确认'}</span>
                <span className={'recovery-tag '+(candidate.conflict ? 'conflict' : 'complete')}>{candidate.conflict ? '版本先后不明' : '基线一致'}</span></span>
              <small>本会话快照序号 {candidate.sequence}</small>
            </button>;
          })}
        </div>
        {selected && <div className={'recovery-selected'+(complete && !selected.conflict ? ' safe' : '')}>
          <div className="recovery-selection-heading"><h3>所选草稿 · 全文</h3><span className={'recovery-tag '+(complete && !selected.conflict ? 'complete' : 'conflict')}>{complete ? selected.conflict ? '版本先后不明' : '可确认接续' : '不可应用'}</span></div>
          {selected.integrityError && <p className="recovery-detail-error" role="alert">{selected.integrityError} 此记录不能作为完整草稿应用。</p>}
          {!supported && <p className="recovery-detail-error">此格式无法完整识别，原始正文只读保留，不能应用恢复。</p>}
          <RecoveryPreview key={`${selected.id}/${selected.sequence}`} content={selected.draft} label="所选恢复草稿全文"/>
          <div className="recovery-actions">
            {complete && !selected.conflict && <button className="primary" disabled={busy} onClick={() => onRecover(selected, false)}>继续此版本</button>}
            <button disabled={busy || !complete} onClick={() => onRecover(selected, true)}>另存恢复作品</button>
          </div>
          <p className="recovery-caption">{complete && !selected.conflict ? '接续前会再次核对基线与快照序号；当前窗口的未保存内容须先完整留存。' : '不能判断先后或内容完整性时，不覆盖原正文。完整草稿可另存为新作品。'}</p>
        </div>}
      </div>
      <aside className="recovery-help" aria-label="恢复说明"><h2>恢复说明</h2>
        <h3>仅在确认安全时接续</h3><p>基线一致且草稿完整时，可确认继续此版本。应用前仍会重新检查。</p>
        <h3>另存恢复作品</h3><p>完整草稿会成为独立的新作品；原正文保留，图片一并复制。失败时保留双方内容。</p>
        <h3>这份记录的范围</h3><p>只包含已经完整写入本地的恢复快照，不是历史版本列表或完整备份。不会自动删除作者内容，也不会发送 AI 请求。</p>
      </aside>
    </div>
  </section>;
}
