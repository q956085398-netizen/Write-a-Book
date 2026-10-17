import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { application } from './application';
import { EditorSession } from './editor-session';
import { characterCount, errorText, type LibraryView, type RecoveryCandidate } from './model';
import { RichEditor } from './RichEditor';
import { CloseReminder, SaveFailureBanner } from './recovery-status';
import { RecoveryPanel } from './RecoveryPanel';
import { documentText } from './rich-content';
import './styles.css';

const compositionNotice = '请先完成中文输入，再保存或关闭。当前文字仍保留。';
const saveLabels = { saved:'已保存到本地', unsaved:'尚未保存', saving:'正在保存…', error:'保存未完成' };

export default function App() {
  const [editor] = useState(() => new EditorSession(application));
  const snapshot = useSyncExternalStore(editor.subscribe,editor.getSnapshot);
  const chapter = snapshot.chapter;
  const count = useMemo(() => chapter ? characterCount(documentText(chapter)) : 0, [chapter?.body, chapter?.bodyFormat]);
  const [library,setLibrary] = useState<LibraryView|null>(null);
  const [defaultPath,setDefaultPath] = useState('');
  const [ready,setReady] = useState(false);
  const [busy,setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error,setError] = useState<string|null>(null);
  const [creating,setCreating] = useState(false);
  const [closeWarning,setCloseWarning] = useState(false);
  const [closing,setClosing] = useState(false);
  const [recoveryOpen,setRecoveryOpen] = useState(false);
  const [recoveryRecords,setRecoveryRecords] = useState<RecoveryCandidate[]>([]);
  const [recoveryError,setRecoveryError] = useState<string|null>(null);
  const [recoveryResult,setRecoveryResult] = useState<string|null>(null);
  const [workTitle,setWorkTitle] = useState('');
  const closeRef = useRef<() => Promise<void>>(async () => {});
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const currentWork = library?.works.find(work => work.id===chapter?.workId);

  // Closing or switching must never force an IME candidate to become committed text.
  async function settleInput() {
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
      setError(editor.isComposing() ? compositionNotice : editor.getSnapshot().error ? null : errorText(cause));
      return false;
    }
    finally { busyRef.current=false; setBusy(false); }
  }
  function accept(next:LibraryView) {
    editor.load(next.chapter); setLibrary(next); setCreating(false);
    setRecoveryOpen(false); setRecoveryRecords([]); setRecoveryError(null); setRecoveryResult(null);
  }
  async function selectLibrary(path?:string) {
    await action(async () => {
      const chosen = path ?? await open({directory:true,multiple:false,title:'选择资料库文件夹'});
      if (typeof chosen === 'string') { accept(await application.openLibrary(chosen)); await readRecovery(); }
    });
  }
  async function createWork() {
    const changed = await action(async () => { accept(await application.createWork(workTitle)); setWorkTitle(''); await readRecovery(); });
    if (changed) document.getElementById('chapter-body')?.focus();
  }
  async function selectWork(id:string) {
    const changed = await action(async () => {
      const next = await application.selectWork(id);
      editor.load(next);
      setCreating(false); setRecoveryOpen(false);
    });
    if (changed) document.getElementById('chapter-body')?.focus();
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
    await recoveryAction(async () => {
      await readRecovery();
      if (editor.isComposing()) throw new Error(compositionNotice);
      setRecoveryOpen(true);
    });
  }
  async function recover(candidate: RecoveryCandidate, asCopy: boolean) {
    if (candidate.integrityError || (!asCopy && candidate.conflict)) return;
    await recoveryAction(async () => {
      const next=await application.recoverChapter(candidate.id,candidate.sequence,asCopy);
      editor.loadRecovered(next.chapter); setLibrary(next); setCreating(false); setRecoveryOpen(false);
      setRecoveryResult(asCopy ? '已另存为恢复作品。原章节与图片继续保留。' : '已继续所选恢复版本。');
      await readRecovery();
    });
  }
  closeRef.current = async () => {
    if (busyRef.current) return;
    setClosing(true);
    const closed = await action(async () => { await getCurrentWindow().destroy(); });
    setClosing(false);
    if (!closed && !editor.isComposing()) setCloseWarning(true);
  };
  saveRef.current = async () => { await action(async () => {}); };
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
    return () => { disposed=true;unlisten?.();window.removeEventListener('keydown',shortcut);editor.dispose(); };
  },[]);
  const compositionProps = {
    onCompositionStart: () => editor.beginComposition(),
    onCompositionEnd: () => editor.endComposition(),
  };

  return <div className="app" onCompositionEndCapture={() => setError(current => current === compositionNotice ? null : current)} onMouseDownCapture={event => { if (editor.isComposing() && event.target instanceof Element && event.target.closest('button')) event.preventDefault(); }}>
    <header className="app-header" inert={closeWarning}>
      <span className="brand"><span className="brand-mark" aria-hidden="true">书</span>写一本书</span>
      {currentWork && <span className="book-context">{currentWork.title}</span>}
      <span className="local-label">本地写作</span>
    </header>
    {error && <div className="error-banner" role="alert" inert={closeWarning}><span>{error}</span></div>}
    {!library ? <main className="welcome" inert={closeWarning}>
      <span className="eyebrow">你的书，从这里开始</span>
      <h1>留一个地方，<br/>写下第一句话。</h1>
      <p>选择资料库，让作品保存在你自己的电脑上。<br/>无需账户，离线也能继续写。</p>
      <div className="welcome-actions">
        <button className="primary" disabled={!ready || busy} onClick={() => void selectLibrary(defaultPath)}>使用默认资料库</button>
        <button disabled={!ready || busy} onClick={() => void selectLibrary()}>选择其他文件夹</button>
      </div>
      {defaultPath && <p className="location">默认位置<span>{defaultPath}</span></p>}
    </main> : <div className="workspace" inert={closeWarning}>
      <aside className="sidebar" aria-label="作品与章节">
        <div className="section-heading"><span>作品</span><button title="新建作品" aria-label="新建作品" disabled={busy} onClick={() => void action(async () => setCreating(true))}>＋</button></div>
        <nav className="work-list">
          {library.works.map(work => <button key={work.id} className={work.id===chapter?.workId?'selected':''} disabled={busy}
            onClick={() => void selectWork(work.id)}><span className="work-icon" aria-hidden="true">▤</span><span>{work.title}</span></button>)}
        </nav>
        {currentWork && <div className="chapter-directory"><div className="section-heading">写作</div>
          <div className="chapter-item" aria-current="page"><span aria-hidden="true">≡</span>{chapter?.title || '未命名章节'}</div></div>}
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
        {recoveryOpen ? <RecoveryPanel current={chapter} currentStatus={saveLabels[snapshot.status]} candidates={recoveryRecords} error={recoveryError} busy={busy}
          onRefresh={() => void recoveryAction(readRecovery)} onReturn={() => setRecoveryOpen(false)} onRecover={(candidate,asCopy) => void recover(candidate,asCopy)}/> : <>
        {creating || !chapter ? <section className="new-work">
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
          <div className="document-bar"><span className="active-tab">{chapter.title || '未命名章节'}</span>
            <div className="save-tools"><span className={'save-state '+snapshot.status} role="status">{saveLabels[snapshot.status]}</span>
              <button disabled={busy} title="保存（Ctrl+S）" onClick={() => void saveRef.current()}>保存</button></div></div>

          <div className="editor-scroll">
            <section className="manuscript">
              <label className="sr-only" htmlFor="chapter-title">章节标题</label>
              <input id="chapter-title" className="chapter-title" value={chapter.title} readOnly={busy}
                {...compositionProps} onChange={event => editor.edit('title',event.target.value)}/>
              <RichEditor key={chapter.contentId} chapter={chapter} session={editor} disabled={busy}/>
            </section>
          </div>
          <footer className="editor-footer"><span>字数（含标点） {count}</span><span>图文 · 本地资料库</span></footer>
        </>}
        </>}
      </main>
    </div>}
    {closeWarning && <CloseReminder snapshot={snapshot} error={error} busy={busy || closing} onReturn={() => setCloseWarning(false)} onRetryClose={() => void closeRef.current()}/>}
  </div>;
}
