import { useEffect, useRef, useState } from 'react';
import { buildExportRequest, selectedChapters, type ExportManifest, type ExportPort, type ExportReceipt, type ExportScope } from './export-port';
import './manuscript-export.css';
export function ManuscriptExport({ workId, currentEntryId, port, beforeExport, onClose, onActivityChange, closeRequested = false }: { workId: string; currentEntryId: string; port: ExportPort; beforeExport: () => Promise<void>; onClose: () => void; onActivityChange?: (busy: boolean) => void; closeRequested?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operationBusy = useRef(false);
  const activityCallback = useRef(onActivityChange); activityCallback.current = onActivityChange;
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [scopeKind, setScopeKind] = useState<'current' | 'selected' | 'book'>('current');
  const [selection, setSelection] = useState<string[]>([]);
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const [format, setFormat] = useState<'docx' | 'txt'>('docx');
  const [target, setTarget] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ExportReceipt | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function beginActivity(): boolean { if (operationBusy.current) return false; operationBusy.current = true; activityCallback.current?.(true); setBusy(true); return true; }
  function endActivity() { operationBusy.current = false; activityCallback.current?.(false); setBusy(false); }
  function applyManifest(value: ExportManifest) { setManifest(value); setSelection([]); setPlacements({}); setReceipt(null); setError(''); setScopeKind(value.chapters.some(entry => entry.id === currentEntryId) ? 'current' : 'selected'); }
  useEffect(() => {
    let alive = true; beginActivity();
    void port.manifest(workId).then(value => { if (alive) applyManifest(value); }).catch(cause => { if (alive) setError(String(cause)); }).finally(() => { if (alive) endActivity(); });
    return () => { alive = false; operationBusy.current = false; activityCallback.current?.(false); };
  }, [port, workId, currentEntryId]);
  async function reloadManifest() {
    if (!beginActivity()) return;
    setManifest(null); setError(''); setReceipt(null); setSelection([]); setPlacements({});
    try { applyManifest(await port.manifest(workId)); } catch (cause) { setError(String(cause)); } finally { endActivity(); }
  }
  const scope: ExportScope = scopeKind === 'book' ? { type: 'book' } : scopeKind === 'current' ? { type: 'current', entryId: currentEntryId } : { type: 'selected', entryIds: selection };
  const chapters = manifest ? selectedChapters(manifest, scope) : [];
  async function chooseTarget() {
    if (!beginActivity()) return; setError(''); setReceipt(null);
    try { const chosen = await port.chooseTarget(format, manifest?.title || '书稿'); if (chosen) { setTarget(chosen); setReplace(false); } }
    catch (cause) { setError(String(cause)); } finally { endActivity(); }
  }
  async function exportNow() {
    if (!manifest) return;
    if (!beginActivity()) return; setError(''); setReceipt(null);
    try { const request = buildExportRequest(manifest, scope, placements, format, target, acknowledge, replace); await beforeExport(); const result = await port.export(request); setReceipt(result); }
    catch (cause) { setError(String(cause)); } finally { endActivity(); }
  }
  function changeScope(value: typeof scopeKind) { setScopeKind(value); setReceipt(null); }
  return <dialog ref={dialog} className="manuscript-export" aria-labelledby="manuscript-export-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><p className="export-eyebrow">独立书稿文件</p><h2 id="manuscript-export-title">导出书稿</h2></div><button type="button" onClick={onClose} disabled={busy}>关闭</button></header>
    {closeRequested && <p role="status">导出操作正在进行，请等待完成后再关闭窗口。</p>}
    {!manifest ? <><p role={error ? 'alert' : 'status'}>{error || '正在读取当前作品目录…'}</p><button disabled={busy} onClick={() => void reloadManifest()}>重新读取目录</button></> : <>
      <p className="export-description">{manifest.title} · 仅导出正文。构思、随记与参考不会加入。章节按目录顺序排列。</p>
      <button disabled={busy} onClick={() => void reloadManifest()}>重新读取目录</button>
      <fieldset disabled={busy}><legend>导出范围</legend><div className="export-scope-options">{(['current', 'selected', 'book'] as const).map((value, index) => <label key={value}><input type="radio" name="export-scope" checked={scopeKind === value} disabled={value === 'current' && !manifest.chapters.some(entry => entry.id === currentEntryId)} onChange={() => changeScope(value)}/>{['当前章', '选定章节', '全书'][index]}</label>)}</div>
        {scopeKind === 'selected' && <div className="export-chapters">{manifest.chapters.map(entry => <label key={entry.id}><input type="checkbox" checked={selection.includes(entry.id)} onChange={event => { setSelection(previous => event.target.checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id)); setReceipt(null); }}/><span>{entry.volumeTitle && `${entry.volumeTitle} / `}{entry.title}</span></label>)}{!manifest.chapters.length && <p>尚无已编入章节的正文，可主动加入下方片段。</p>}</div>}
      </fieldset>
      {!!manifest.fragments.length && <fieldset disabled={busy}><legend>主动加入正文片段</legend><p className="export-hint">勾选后指定位置；同一位置按下列片段顺序导出。原目录和正文不变。</p><div className="export-fragments">{manifest.fragments.map(entry => <div className="export-fragment" key={entry.id}><label><input type="checkbox" checked={Object.hasOwn(placements, entry.id)} onChange={event => { setPlacements(previous => { const next = { ...previous }; if (event.target.checked) next[entry.id] = ''; else delete next[entry.id]; return next; }); setReceipt(null); }}/>{entry.title}</label>{Object.hasOwn(placements, entry.id) && <select aria-label={`${entry.title}插入位置`} value={placements[entry.id]} onChange={event => { setPlacements(previous => ({ ...previous, [entry.id]: event.target.value })); setReceipt(null); }}><option value="">请选择位置</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.volumeTitle && `${chapter.volumeTitle} / `}{chapter.title}之前</option>)}<option value="__end__">本次书稿末尾</option></select>}</div>)}</div></fieldset>}
      <fieldset disabled={busy}><legend>文件格式</legend><div className="export-scope-options"><label><input type="radio" name="export-format" checked={format === 'docx'} onChange={() => { setFormat('docx'); setTarget(''); setReceipt(null); }}/>Word (.docx)</label><label><input type="radio" name="export-format" checked={format === 'txt'} onChange={() => { setFormat('txt'); setTarget(''); setAcknowledge(false); setReceipt(null); }}/>TXT (.txt)</label></div>
        {format === 'txt' ? <label className="export-loss"><input type="checkbox" checked={acknowledge} onChange={event => { setAcknowledge(event.target.checked); setReceipt(null); }}/>我已知悉：TXT 只保留文字，图片、链接与文字样式不会保留。</label> : <p className="export-hint">保留标题、粗体、斜体、下划线、列表、引用、链接及受管图片。WebP 在本地转为 PNG；原图片不变。</p>}
      </fieldset>
      <div className="export-destination"><button disabled={busy} onClick={() => void chooseTarget()}>选择导出位置</button>{target && <p>{target}</p>}{target && <label><input type="checkbox" checked={replace} disabled={busy} onChange={event => { setReplace(event.target.checked); setReceipt(null); }}/>若此文件已存在，允许用本次书稿替换</label>}</div>
      <p className="export-preview">本次范围：{chapters.length} 章，{Object.keys(placements).length} 个主动片段。</p>
      {error && <p className="export-error" role="alert">{error}</p>}
      {receipt && <div className="export-receipt" role="status"><strong>书稿已写入文件</strong><p>{receipt.path}</p><p>{receipt.chapterCount} 章 · {receipt.fragmentCount} 个片段 · {format === 'docx' ? `${receipt.imageCount} 张受管图片 · ` : ''}{receipt.bytes.toLocaleString()} 字节</p><p>请使用 Word 或文本阅读器打开文件，核对范围、顺序与内容。</p></div>}
      <footer><button type="button" disabled={busy} onClick={onClose}>关闭</button><button type="button" className="primary" disabled={busy || !target || (format === 'txt' && !acknowledge)} onClick={() => void exportNow()}>{busy ? '正在处理…' : '确认导出'}</button></footer>
    </>}
  </dialog>;
}
