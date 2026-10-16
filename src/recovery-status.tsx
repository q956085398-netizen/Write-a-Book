import { useEffect, useRef } from 'react';
import type { EditorSnapshot } from './editor-session';

export function recoveryMessage(snapshot: EditorSnapshot) {
  if (snapshot.recovery === 'retained') return '当前完整草稿已留存在本地恢复记录。';
  if (snapshot.recovery === 'pending') return '最新输入仍在当前窗口，恢复草稿正在更新。';
  if (snapshot.recovery === 'error') return '最新草稿尚未完整留存，请保持窗口打开。';
  return '当前输入仍保留，请重试保存。';
}

export function SaveFailureBanner({ snapshot, busy, onRetry }: { snapshot: EditorSnapshot; busy: boolean; onRetry: () => void }) {
  return <div className="save-failure" role="alert">
    <span className="save-warning-mark" aria-hidden="true">!</span>
    <div className="save-failure-message"><strong>{snapshot.status === 'saving' ? '正在重试保存…' : '保存未完成'}</strong>
      <span>{recoveryMessage(snapshot)}</span><small>{snapshot.error}</small></div>
    <button disabled={busy} onClick={onRetry}>重试保存</button>
  </div>;
}

export function CloseReminder({ snapshot, error, busy, onReturn, onRetryClose }: {
  snapshot: EditorSnapshot; error: string | null; busy: boolean; onReturn: () => void; onRetryClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const saved = snapshot.status === 'saved';
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="close-overlay" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault();onReturn(); }
    if (event.key === 'Tab') {
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (!buttons.length) { event.preventDefault();return; }
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length].focus();
    }
  }}>
    <section className="close-reminder" ref={panel} role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-description">
      <div className="close-heading"><span className={'save-warning-mark'+(saved?' saved':'')} aria-hidden="true">{saved?'✓':'!'}</span><h2 id="close-title">{saved ? '内容已保存，可以关闭' : '关闭前，还有内容未保存'}</h2></div>
      <div id="close-description"><p>{saved ? '当前内容已成功保存到本地资料库。' : recoveryMessage(snapshot)}</p>
        {!saved && <p>本次关闭已暂停。可继续编辑，或重试保存后关闭。</p>}
        {!saved && (snapshot.error || error) && <p className="close-detail">{snapshot.error || error}</p>}</div>
      <div className="close-actions"><button ref={returnButton} disabled={busy} onClick={onReturn}>继续编辑</button>
        <button className="primary" disabled={busy} onClick={onRetryClose}>{busy ? '正在保存…' : saved ? '关闭窗口' : '重试保存并关闭'}</button></div>
    </section>
  </div>;
}
