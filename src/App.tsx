import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { application } from './application';
import { EditorSession } from './editor-session';
import { errorText, type LibraryView, type RecoveryCandidate, type StructureChange } from './model';
import { RichEditor } from './RichEditor';
import { CloseReminder, SaveFailureBanner } from './recovery-status';
import { RecoveryPanel } from './RecoveryPanel';
import { ApiSettings, type ApiSettingsActivity } from './ApiSettings';
import { CharacterCountFooter } from './character-count/CharacterCountFooter';
import { useCharacterCounts } from './character-count/useCharacterCounts';
import { WorkShelf } from './WorkShelf';
import { WritingDirectory, type StructureIntent } from './WritingDirectory';
import { StructureDialog } from './StructureDialog';
import { ManuscriptExport } from './manuscript-export/ManuscriptExport';
import { nativeExportPort } from './manuscript-export/native-port';
import { ConceptionController, ConceptionWorkspace, conceptionPort } from './conception';
import './styles.css';

const compositionNotice = '请先完成中文输入，再保存或关闭。当前文字仍保留。';
const saveLabels = { saved:'已保存到本地', unsaved:'尚未保存', saving:'正在保存…', error:'保存未完成' };

export default function App() {
  const [editor] = useState(() => new EditorSession(application));
  const [conception] = useState(() => new ConceptionController(conceptionPort));
  const conceptionSnapshot = useSyncExternalStore(conception.subscribe,conception.getSnapshot);
  const [conceptionOpen,setConceptionOpen] = useState(false);
  const snapshot = useSyncExternalStore(editor.subscribe,editor.getSnapshot);
  const chapter = snapshot.chapter;
  const [library,setLibrary] = useState<LibraryView|null>(null);
  const [defaultPath,setDefaultPath] = useState('');
  const [ready,setReady] = useState(false);
  const [busy,setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error,setError] = useState<string|null>(null);
  const [creating,setCreating] = useState(false);
  const [closeWarning,setCloseWarning] = useState(false);
  const [closing,setClosing] = useState(false);
  const [apiOpen,setApiOpen] = useState(false);
  const apiActivity = useRef<ApiSettingsActivity>({ dirty:false, busy:null });
  const [apiCloseWarning,setApiCloseWarning] = useState(false);
  const [apiWaiting,setApiWaiting] = useState(false);
  const [recoveryOpen,setRecoveryOpen] = useState(false);
  const [recoveryRecords,setRecoveryRecords] = useState<RecoveryCandidate[]>([]);
  const [recoveryError,setRecoveryError] = useState<string|null>(null);
  const [recoveryResult,setRecoveryResult] = useState<string|null>(null);
  const [workTitle,setWorkTitle] = useState('');
  const [shelfOpen,setShelfOpen] = useState(false);
  const [shelfMode,setShelfMode] = useState<'shelf'|'list'>('shelf');
  const [structureIntent,setStructureIntent] = useState<StructureIntent|null>(null);
  const [structureResult,setStructureResult] = useState<string|null>(null);
  const [exportOpen,setExportOpen] = useState(false);
  const [exportWaiting,setExportWaiting] = useState(false);
  const exportBusyRef = useRef(false);
  const hadStructureDialog = useRef(false);
  const closeRef = useRef<() => Promise<void>>(async () => {});
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const currentWork = library?.works.find(work => work.id===chapter?.workId);
  const entries = (library?.entries ?? []).map(entry => entry.id === chapter?.id ? { ...entry, title: chapter.title } : entry);
  const volumes = library?.volumes ?? [];
  const currentEntry = entries.find(entry => entry.id === chapter?.id);
  const isFragment = currentEntry?.kind === 'fragment';
  const characterCounts = useCharacterCounts(library, chapter, busy || snapshot.status === 'saving' || snapshot.status === 'error');

  // Closing or switching must never force an IME candidate to become committed text.
  async function settleInput() {
    if (!(await conception.flush())) throw new Error(conception.getSnapshot().editor.error ?? conception.getSnapshot().error ?? compositionNotice);
    if (!(await editor.flush())) throw new Error(editor.getSnapshot().error ?? compositionNotice);
  }
  async function action(operation: () => Promise<void>) {
    if (busyRef.current) return false;
    busyRef.current=true;
    try {
      await settleInput();
      setBusy(true); setError(null);
      await operation();
      return true;
    } catch (cause) {
      // Persistence errors belong to EditorSession so a later successful autosave clears them.
      setError(editor.isComposing() || conception.isComposing() ? compositionNotice : editor.getSnapshot().error ? null : errorText(cause));
      return false;
    }
    finally { busyRef.current=false; setBusy(false); }
  }
  function accept(next:LibraryView) {
    editor.load(next.chapter); setLibrary(next); setCreating(false); setShelfOpen(false); setConceptionOpen(false); setStructureIntent(null); setStructureResult(null);
    setRecoveryOpen(false); setRecoveryRecords([]); setRecoveryError(null); setRecoveryResult(null);
  }
  async function selectLibrary(path?:string) {
    await action(async () => {
      const chosen = path ?? await open({directory:true,multiple:false,title:'选择资料库文件夹'});
      if (typeof chosen === 'string') { const next=await application.openLibrary(chosen);conception.reset();accept(next);await readRecovery(); }
    });
  }
  async function createWork() {
    const changed = await action(async () => { accept(await application.createWork(workTitle)); setWorkTitle(''); await readRecovery(); });
    if (changed) document.getElementById('chapter-body')?.focus();
  }
  async function selectWork(id:string) {
    const changed = await action(async () => {
      accept(await application.selectWork(id));
    });
    if (changed) document.getElementById('chapter-body')?.focus();
  }
  async function selectEntry(id: string) {
    const changed = await action(async () => accept(await application.selectEntry(id)));
    if (changed) document.getElementById('chapter-body')?.focus();
  }
  async function showShelf() {
    await action(async () => { setLibrary(await application.libraryView()); setShelfOpen(true); setCreating(false); setRecoveryOpen(false); setConceptionOpen(false); });
  }
  async function showConception() {
    if (!currentWork) return;
    await action(async () => {
      if (!(await conception.openWork(currentWork.id))) throw new Error(conception.getSnapshot().error ?? '构思暂时无法打开，正文仍保留。');
      setConceptionOpen(true);setShelfOpen(false);setCreating(false);setRecoveryOpen(false);
    });
  }
  async function showWriting() {
    await action(async () => {setConceptionOpen(false);setShelfOpen(false);setCreating(false);setRecoveryOpen(false);});
  }
  async function showStructure(intent: StructureIntent) {
    await action(async () => setStructureIntent(intent));
  }
  async function changeStructure(change: StructureChange) {
    const changed = await action(async () => {
      const next = await application.changeStructure(change);
      accept(next);
      setStructureResult(change.type === 'compileFragment' ? '已编为新章节。原片段的文字与图片完整保留。' : '目录已保存到本地。');
    });
    if (changed) document.getElementById('chapter-body')?.focus();
  }
  function moveEntry(id: string, volumeId: string | null, beforeId: string | null) {
    if (currentWork) void changeStructure({ type:'move', workId:currentWork.id, expectedRevision:currentWork.structureRevision ?? 0, id, volumeId, beforeId });
  }
  async function readRecovery() {
    try { setRecoveryRecords(await application.listRecovery()); setRecoveryError(null); }
    catch (cause) { setRecoveryError(`恢复记录读取失败：${errorText(cause)}`); }
  }
  // Recovery can branch from a revision conflict: preserve exact input without requiring a main save.
  async function recoveryAction(operation: () => Promise<void>) {
    if (busyRef.current) return;
    if (editor.isComposing()) { setError(compositionNotice); return; }
    busyRef.current=true; setBusy(true); setError(null); setRecoveryError(null);
    try {
      if (!(await editor.preserveForRecovery())) throw new Error(editor.getSnapshot().error ?? compositionNotice);
      if (editor.isComposing()) throw new Error(compositionNotice);
      await operation();
    } catch (cause) {
      if (editor.isComposing()) setError(compositionNotice);
      else setRecoveryError(errorText(cause));
    } finally { busyRef.current=false; setBusy(false); }
  }
  async function showRecovery() {
    if (!(await conception.flush())) {setError(conception.getSnapshot().editor.error ?? conception.getSnapshot().error ?? compositionNotice);return;}
    await recoveryAction(async () => {
      await readRecovery();
      if (editor.isComposing()) throw new Error(compositionNotice);
      setRecoveryOpen(true);setConceptionOpen(false);
    });
  }
  async function recover(candidate: RecoveryCandidate, asCopy: boolean) {
    if (candidate.integrityError || (!asCopy && candidate.conflict)) return;
    await recoveryAction(async () => {
      const next=await application.recoverChapter(candidate.id,candidate.sequence,asCopy);
      editor.loadRecovered(next.chapter); setLibrary(next); setCreating(false); setRecoveryOpen(false); setShelfOpen(false); setStructureIntent(null);
      setRecoveryResult(asCopy ? '已另存为恢复作品。原正文与图片继续保留。' : '已继续所选恢复版本。');
      await readRecovery();
    });
  }
  async function closeWindow() {
    if (busyRef.current) return;
    setClosing(true);
    const closed = await action(async () => { await getCurrentWindow().destroy(); });
    setClosing(false);
    if (!closed && !editor.isComposing() && !conception.isComposing()) setCloseWarning(true);
  }
  closeRef.current = async () => {
    if (exportBusyRef.current) { setExportWaiting(true); return; }
    if (exportOpen) { setExportOpen(false); setExportWaiting(false); }
    if (structureIntent) { setError('请先保存或取消当前目录操作，再关闭窗口。'); return; }
    if (apiOpen && apiActivity.current.busy) { setApiWaiting(true); return; }
    if (apiOpen && apiActivity.current.dirty) { setApiCloseWarning(true); return; }
    await closeWindow();
  };
  saveRef.current = async () => { if (!apiOpen && !structureIntent) await action(async () => {}); };
  useEffect(() => {
    if (!isTauri()) {
      setError('请在 Windows 应用中打开写一本书。浏览器页面无法访问本地资料库。');
      return;
    }
    let disposed=false;
    let unlisten:(()=>void)|undefined;
    void (async () => {
      try {
        unlisten=await getCurrentWindow().onCloseRequested(event => {
          event.preventDefault();
          void closeRef.current();
        });
        const boot=await application.bootstrap();
        if (disposed) return;
        setDefaultPath(boot.defaultPath);
        if (boot.library) { accept(boot.library); await readRecovery(); }
        setError(boot.restoreError);
        setReady(true);
      } catch(cause) { if (!disposed) setError(errorText(cause)); }
    })();
    const shortcut=(event:KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase()==='s') { event.preventDefault(); void saveRef.current(); }
    };
    window.addEventListener('keydown',shortcut);
    return () => { disposed=true;unlisten?.();window.removeEventListener('keydown',shortcut);editor.dispose();conception.dispose(); };
  },[]);
  useEffect(() => {
    if (hadStructureDialog.current && !structureIntent) document.getElementById('chapter-body')?.focus();
    hadStructureDialog.current = !!structureIntent;
  }, [structureIntent]);
  const compositionProps = {
    onCompositionStart: () => editor.beginComposition(),
    onCompositionEnd: () => editor.endComposition(),
  };

  return <div className="app" onCompositionEndCapture={() => setError(current => current === compositionNotice ? null : current)} onMouseDownCapture={event => { if ((editor.isComposing() || conception.isComposing()) && event.target instanceof Element && event.target.closest('button')) event.preventDefault(); }}>
    <header className="app-header" inert={closeWarning || apiCloseWarning || !!structureIntent}>
      <span className="brand"><span className="brand-mark" aria-hidden="true">书</span>写一本书</span>
      {currentWork && <span className="book-context">{currentWork.title}</span>}
      <span className="local-label">本地写作</span>
      {library && !apiOpen && <button disabled={busy} onClick={() => void showShelf()}>作品书架</button>}
      {library && chapter && !apiOpen && <button disabled={busy} onClick={() => void action(async () => {setExportOpen(true);setExportWaiting(false);})}>导出书稿</button>}
      {!apiOpen && <button disabled={!ready || busy} onClick={() => void action(async () => { apiActivity.current={dirty:false,busy:'loading'};setApiOpen(true); })}>AI 与 API</button>}
    </header>
    {error && <div className="error-banner" role="alert" inert={closeWarning}><span>{error}</span></div>}
    {apiOpen ? <div className="api-host" inert={closeWarning || apiCloseWarning || !!structureIntent}>
      {apiWaiting && <p className="error-banner" role="status">API 操作正在进行，请等待完成后再关闭窗口。</p>}
      <ApiSettings onClose={() => {setApiOpen(false);setApiWaiting(false);}} onStateChange={activity => {apiActivity.current=activity;if (!activity.busy) setApiWaiting(false);}}/>
    </div> : !library ? <main className="welcome" inert={closeWarning}>
      <span className="eyebrow">你的书，从这里开始</span>
      <h1>留一个地方，<br/>写下第一句话。</h1>
      <p>选择资料库，让作品保存在你自己的电脑上。<br/>无需账户，离线也能继续写。</p>
      <div className="welcome-actions">
        <button className="primary" disabled={!ready || busy} onClick={() => void selectLibrary(defaultPath)}>使用默认资料库</button>
        <button disabled={!ready || busy} onClick={() => void selectLibrary()}>选择其他文件夹</button>
      </div>
      {defaultPath && <p className="location">默认位置<span>{defaultPath}</span></p>}
    </main> : <div className="workspace" inert={closeWarning || !!structureIntent}>
      <aside className="sidebar" aria-label="作品与章节">
        <div className="section-heading"><span>作品</span><button title="新建作品" aria-label="新建作品" disabled={busy} onClick={() => void action(async () => {setCreating(true);setShelfOpen(false);setRecoveryOpen(false);setConceptionOpen(false);})}>＋</button></div>
        <nav className="work-list">
          {library.works.map(work => <button key={work.id} className={work.id===chapter?.workId?'selected':''} disabled={busy}
            onClick={() => void selectWork(work.id)}><span className="work-icon" aria-hidden="true">▤</span><span>{work.title}</span></button>)}
        </nav>
        {currentWork && <nav className="work-mode" aria-label="当前作品目录"><button className={!conceptionOpen ? 'selected' : ''} disabled={busy} onClick={() => void showWriting()}>写作</button><button className={conceptionOpen ? 'selected' : ''} disabled={busy} onClick={() => void showConception()}>构思</button></nav>}
        {!conceptionOpen && currentWork && chapter && <WritingDirectory entries={entries} volumes={volumes} activeId={chapter.id} busy={busy}
          onSelect={id => void selectEntry(id)} onIntent={intent => void showStructure(intent)} onMove={moveEntry}/>}
        <button className="recovery-sidebar-entry" disabled={busy} onClick={() => void showRecovery()}>恢复记录{recoveryRecords.length > 0 ? ` · ${recoveryRecords.length}` : ""}</button>
        <div className="library-location"><span>资料库位置</span><p title={library.path}>{library.path}</p>
          <button disabled={busy} onClick={() => void selectLibrary()}>切换资料库</button></div>
      </aside>
      <main className="main-area">
        {snapshot.error && <SaveFailureBanner snapshot={snapshot} busy={busy || closing} onRetry={() => void saveRef.current()} onRecovery={() => void showRecovery()}/>}
        {!recoveryOpen && (recoveryRecords.length > 0 || recoveryError || recoveryResult) && <div className="recovery-entry-notice" aria-live="polite">
          <span>{recoveryError || recoveryResult || `检测到 ${recoveryRecords.length} 份待核对的本地恢复草稿。请查看后选择，不会自动覆盖正文。`}</span>
          <button disabled={busy} onClick={() => void showRecovery()}>查看恢复记录</button>
        </div>}
        {conceptionOpen ? <ConceptionWorkspace controller={conception} disabled={busy} onReturn={() => void showWriting()}/> : recoveryOpen ? <RecoveryPanel current={chapter} currentStatus={saveLabels[snapshot.status]} candidates={recoveryRecords} error={recoveryError} busy={busy}
          onRefresh={() => void recoveryAction(readRecovery)} onReturn={() => setRecoveryOpen(false)} onRecover={(candidate,asCopy) => void recover(candidate,asCopy)}/> : <>
        {structureResult && <div className="structure-result" aria-live="polite">{structureResult}</div>}
        {shelfOpen ? <WorkShelf works={library.works} mode={shelfMode} busy={busy} onMode={setShelfMode} onSelect={id => void selectWork(id)} onCreate={() => void action(async () => {setCreating(true);setShelfOpen(false);})}/> : creating || !chapter ? <section className="new-work">
          <span className="eyebrow">新建创作作品</span><h1>先取个暂名，<br/>然后开始写。</h1>
          <p>名字还没想好，也可以直接开始。</p>
          <form onSubmit={event => { event.preventDefault();void createWork(); }}>
            <label htmlFor="work-title">作品暂名</label>
            <input id="work-title" autoFocus value={workTitle} placeholder="未命名作品" disabled={busy}
              onChange={event => setWorkTitle(event.target.value)}/>
            <div className="form-actions"><button type="submit" className="primary" disabled={busy}>创建作品并写首章</button>
              {chapter && <button type="button" disabled={busy} onClick={() => setCreating(false)}>返回正文</button>}</div>
          </form>
        </section> : <>
          <div className="document-bar"><span className="active-tab">{isFragment ? '片段 · ' : ''}{chapter.title || (isFragment ? '未命名片段' : '未命名章节')}</span>
            <div className="save-tools">{isFragment && <button disabled={busy} onClick={() => void showStructure({type:'compileFragment',id:chapter.id})}>编为新章节</button>}<span className={'save-state '+snapshot.status} role="status">{saveLabels[snapshot.status]}</span>
              <button disabled={busy} title="保存（Ctrl+S）" onClick={() => void saveRef.current()}>保存</button></div></div>

          <div className="editor-scroll">
            <section className="manuscript">
              <label className="sr-only" htmlFor="chapter-title">{isFragment ? '片段标题' : '章节标题'}</label>
              <input id="chapter-title" className="chapter-title" value={chapter.title} readOnly={busy}
                {...compositionProps} onChange={event => editor.edit('title',event.target.value)}/>
              <RichEditor key={chapter.contentId} chapter={chapter} session={editor} disabled={busy} label={isFragment ? '片段正文' : '章节正文'} onCharacterCountsChange={characterCounts.onCounts}/>
            </section>
          </div>
          <footer className="editor-footer"><CharacterCountFooter counts={characterCounts.counts} live={characterCounts.live} kind={isFragment ? 'fragment' : 'chapter'}/><span>{isFragment ? '未编章片段' : '章节'} · 本地资料库</span></footer>
        </>}
        </>}
      </main>
    </div>}
    {exportOpen && chapter && <ManuscriptExport workId={chapter.workId} currentEntryId={chapter.id} port={nativeExportPort} closeRequested={exportWaiting}
      beforeExport={async () => {if (!(await action(async () => {}))) throw new Error(editor.getSnapshot().error ?? compositionNotice);}}
      onActivityChange={active => {exportBusyRef.current=active;if (!active) setExportWaiting(false);}}
      onClose={() => {if (!exportBusyRef.current) {setExportOpen(false);setExportWaiting(false);}}}/>}
    {structureIntent && currentWork && <StructureDialog intent={structureIntent} workId={currentWork.id} revision={currentWork.structureRevision ?? 0} entries={entries} volumes={volumes} busy={busy} error={error || snapshot.error}
      onCancel={() => { setStructureIntent(null);setError(null); }} onConfirm={change => void changeStructure(change)}/>}
    {closeWarning && <CloseReminder snapshot={conceptionOpen ? conceptionSnapshot.editor : snapshot} error={error || (conceptionOpen ? conceptionSnapshot.error : null)} busy={busy || closing} onReturn={() => setCloseWarning(false)} onRetryClose={() => void closeRef.current()}/>}
    {apiCloseWarning && <div className="close-overlay"><section className="close-reminder" role="alertdialog" aria-modal="true" aria-labelledby="api-close-title" tabIndex={-1} ref={node => node?.focus()}>
      <h2 id="api-close-title">API 配置还有未保存修改</h2><p>返回设置可保存当前填写项；放弃关闭会清除未保存的字段与新密钥。</p>
      <div className="close-actions"><button onClick={() => setApiCloseWarning(false)}>返回设置</button><button onClick={() => {setApiCloseWarning(false);void closeWindow();}}>放弃修改并关闭</button></div>
    </section></div>}
  </div>;
}
