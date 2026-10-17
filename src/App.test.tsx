// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SaveChapter, RecoveryCandidate } from './model';

const chapter = { id: 'chapter', contentId: 'content', workId: 'work', title: '第一章', body: '', revision: 0 };
const native = vi.hoisted(() => ({ saveChapter: vi.fn(), checkpointChapter: vi.fn(), listRecovery: vi.fn(), recoverChapter: vi.fn(), destroy: vi.fn(), close: (_event: {preventDefault: () => void}) => {} }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async (handler: typeof native.close) => { native.close=handler; return () => {}; }, destroy: native.destroy }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./application', () => ({
  application: {
    bootstrap: async () => ({
      defaultPath: 'C:/test-library', restoreError: null,
      library: { path: 'C:/test-library', works: [{ id: 'work', title: '测试作品' }], chapter },
    }),
    saveChapter: native.saveChapter,
    checkpointChapter: native.checkpointChapter, acknowledgeRecovery: async () => {}, listRecovery: native.listRecovery, recoverChapter: native.recoverChapter,
  },
}));
import App from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();native.saveChapter.mockReset();native.checkpointChapter.mockReset();native.checkpointChapter.mockResolvedValue(undefined);native.destroy.mockReset();
  native.destroy.mockResolvedValue(undefined);native.listRecovery.mockReset();native.listRecovery.mockResolvedValue([]);native.recoverChapter.mockReset();
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('removes a manual-save failure banner when later automatic persistence succeeds', async () => {
  vi.useFakeTimers();
  native.saveChapter.mockRejectedValueOnce(new Error('磁盘已满')).mockImplementation(async (draft: SaveChapter) => ({
    ...chapter, ...draft, revision: draft.expectedRevision + 1,
  }));
  await act(async () => { root.render(<App />); });
  const body = container.querySelector<HTMLElement>('#chapter-body')!;
  async function type(text: string) {
    await act(async () => {
      body.querySelector('p')!.textContent = text;
      body.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
    });
  }
  await type('保存失败也要保留。');
  const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存')!;
  await act(async () => { save.click(); await vi.advanceTimersByTimeAsync(0); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('磁盘已满');
  expect(body.textContent).toBe('保存失败也要保留。');

  await type('保存失败也要保留。继续写。');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('磁盘已满');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(native.saveChapter).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('已保存到本地');
  expect(body.textContent).toBe('保存失败也要保留。继续写。');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});


it('keeps a live IME candidate focused when close or new-work is requested', async () => {
  await act(async () => root.render(<App />));
  const title=container.querySelector<HTMLInputElement>('#chapter-title')!;
  await act(async () => {title.focus();title.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));});
  const preventDefault=vi.fn();
  await act(async () => native.close({preventDefault}));
  expect(preventDefault).toHaveBeenCalled();expect(native.destroy).not.toHaveBeenCalled();expect(native.saveChapter).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(title);
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(container.textContent).toContain('请先完成中文输入');
  const create=container.querySelector<HTMLButtonElement>('[aria-label="新建作品"]')!;
  const down=new MouseEvent('mousedown',{bubbles:true,cancelable:true});
  await act(async () => {create.dispatchEvent(down);create.click();});
  expect(down.defaultPrevented).toBe(true);expect(document.activeElement).toBe(title);
  expect(container.querySelector('#work-title')).toBeNull();
});

it('saves the final completed input before normal close and keeps the window on a failed write', async () => {
  native.saveChapter.mockRejectedValueOnce(new Error('受控写入失败')).mockImplementation(async (draft: SaveChapter) => ({ ...chapter,...draft,revision:draft.expectedRevision+1 }));
  await act(async () => root.render(<App />));
  const body=container.querySelector<HTMLElement>('#chapter-body')!;
  await act(async () => {body.querySelector('p')!.textContent='关窗前的最后一句。';body.dispatchEvent(new Event('input',{bubbles:true}));await vi.advanceTimersByTimeAsync(20);});
  await act(async () => native.close({preventDefault:vi.fn()}));
  expect(native.destroy).not.toHaveBeenCalled();expect(body.textContent).toBe('关窗前的最后一句。');
  expect(container.textContent).toContain('受控写入失败');
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('关闭前，还有内容未保存');
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('完整草稿已留存');
  await act(async () => native.close({preventDefault:vi.fn()}));
  expect(native.destroy).toHaveBeenCalledTimes(1);
  expect(native.saveChapter.mock.calls.at(-1)?.[0].body).toContain('关窗前的最后一句。');
});


it('does not promise retained content when recovery storage itself fails, and lets the author return to editing', async () => {
  native.checkpointChapter.mockRejectedValue(new Error('恢复位置不可写'));
  await act(async () => root.render(<App />));
  const body=container.querySelector<HTMLElement>('#chapter-body')!;
  await act(async () => {body.querySelector('p')!.textContent='只在当前窗口的文字';body.dispatchEvent(new Event('input',{bubbles:true}));await vi.advanceTimersByTimeAsync(20);});
  await act(async () => native.close({preventDefault:vi.fn()}));
  const dialog=container.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain('最新草稿尚未完整留存');expect(dialog.textContent).not.toContain('完整草稿已留存');
  expect(native.saveChapter).not.toHaveBeenCalled();expect(native.destroy).not.toHaveBeenCalled();
  const back=Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent==='继续编辑')!;
  await act(async () => back.click());
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(body.textContent).toBe('只在当前窗口的文字');expect(container.querySelector('.save-failure')?.textContent).toContain('恢复位置不可写');
});

it('keeps the close decision with the author after a background retry succeeds', async () => {
  native.saveChapter.mockRejectedValueOnce(new Error('暂时不可写')).mockImplementation(async (draft: SaveChapter) => ({ ...chapter,...draft,revision:draft.expectedRevision+1 }));
  await act(async () => root.render(<App />));
  const body=container.querySelector<HTMLElement>('#chapter-body')!;
  await act(async () => {body.querySelector('p')!.textContent='等待重试';body.dispatchEvent(new Event('input',{bubbles:true}));await vi.advanceTimersByTimeAsync(20);});
  await act(async () => native.close({preventDefault:vi.fn()}));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(native.destroy).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('内容已保存，可以关闭');
  expect(container.querySelector('.save-failure')).toBeNull();
  const close=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='关闭窗口')!;
  await act(async () => close.click());expect(native.destroy).toHaveBeenCalledTimes(1);
});

function recoveryRecord(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return { id:'retained-record', sequence:3, base:chapter, current:chapter, draft:{ id:chapter.id, contentId:chapter.contentId, title:'恢复的章节', body:'恢复草稿的完整末句。', expectedRevision:0 }, conflict:false, integrityError:null, ...overrides };
}
function findButton(text: string) { return Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)!; }
async function openRecovery() { await act(async () => container.querySelector<HTMLButtonElement>('.recovery-sidebar-entry')!.click()); }
async function editBody(text: string) {
  const body=container.querySelector<HTMLElement>('#chapter-body')!;
  await act(async () => { body.querySelector('p')!.textContent=text;body.dispatchEvent(new Event('input',{bubbles:true}));await vi.advanceTimersByTimeAsync(20); });
  return body;
}
it('detects recoverable records on boot, waits for review, and continues only the exact selected sequence', async () => {
  const record=recoveryRecord();native.listRecovery.mockResolvedValue([record]);
  const recovered={...chapter,title:record.draft.title,body:record.draft.body,revision:1};
  native.recoverChapter.mockResolvedValue({path:'C:/test-library',works:[{id:'work',title:'测试作品'}],chapter:recovered});
  await act(async () => root.render(<App />));
  expect(container.textContent).toContain('检测到 1 份');expect(native.recoverChapter).not.toHaveBeenCalled();
  expect(container.querySelector('.recovery-panel')).toBeNull();
  await openRecovery();
  expect(container.querySelector('[aria-label="所选恢复草稿全文"]')?.textContent).toContain(record.draft.body);
  expect(native.saveChapter).not.toHaveBeenCalled();
  native.listRecovery.mockResolvedValue([]);
  await act(async () => findButton('继续此版本').click());
  expect(native.recoverChapter).toHaveBeenCalledWith(record.id,3,false);
  expect(container.querySelector('.recovery-panel')).toBeNull();expect(container.querySelector<HTMLInputElement>('#chapter-title')?.value).toBe(record.draft.title);
  expect(container.querySelector('#chapter-body')?.textContent).toBe(record.draft.body);
  expect(container.textContent).toContain('已继续所选恢复版本');
});
it('branches out of a failed main save without flushing again, preserves both versions on failure, and loads a successful copy', async () => {
  const record=recoveryRecord({conflict:true});native.listRecovery.mockResolvedValue([record]);
  native.saveChapter.mockRejectedValue(new Error('章节版本冲突'));
  const copy={...chapter,id:'copy-chapter',contentId:'copy-content',workId:'copy-work',title:'恢复副本',body:record.draft.body,revision:0};
  native.recoverChapter.mockRejectedValueOnce(new Error('图片复制失败，原数据已保留')).mockResolvedValueOnce({path:'C:/test-library',works:[{id:'work',title:'测试作品'},{id:'copy-work',title:'恢复作品'}],chapter:copy});
  await act(async () => root.render(<App />));await editBody('当前窗口未保存的完整末句。');
  await act(async () => findButton('保存').click());
  expect(native.saveChapter).toHaveBeenCalledTimes(1);expect(container.querySelector('.save-failure')?.textContent).toContain('章节版本冲突');
  await openRecovery();
  expect(native.saveChapter).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="当前窗口正文全文"]')?.textContent).toContain('当前窗口未保存的完整末句。');
  expect(container.querySelector('[aria-label="所选恢复草稿全文"]')?.textContent).toContain(record.draft.body);
  expect(native.checkpointChapter.mock.calls.at(-1)?.[0].draft.body).toContain('当前窗口未保存的完整末句。');
  expect(findButton('继续此版本')).toBeUndefined();
  await act(async () => findButton('另存恢复作品').click());
  expect(native.recoverChapter).toHaveBeenLastCalledWith(record.id,3,true);
  expect(container.querySelector('.recovery-panel')).not.toBeNull();expect(container.textContent).toContain('图片复制失败');
  expect(container.textContent).toContain('当前窗口未保存的完整末句。');expect(container.textContent).toContain(record.draft.body);
  await act(async () => findButton('另存恢复作品').click());
  expect(container.querySelector('.recovery-panel')).toBeNull();expect(container.querySelector('#chapter-body')?.textContent).toBe(copy.body);
  expect(container.querySelector<HTMLInputElement>('#chapter-title')?.value).toBe(copy.title);
  expect(native.saveChapter).toHaveBeenCalledTimes(1);expect(container.textContent).toContain('已另存为恢复作品');
});
it('keeps a live composition and its focus when recovery is requested', async () => {
  native.listRecovery.mockResolvedValue([recoveryRecord()]);
  await act(async () => root.render(<App />));const calls=native.listRecovery.mock.calls.length;
  const title=container.querySelector<HTMLInputElement>('#chapter-title')!;
  await act(async () => {title.focus();title.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));});
  const entry=container.querySelector<HTMLButtonElement>('.recovery-sidebar-entry')!;
  const down=new MouseEvent('mousedown',{bubbles:true,cancelable:true});
  await act(async () => {entry.dispatchEvent(down);entry.click();});
  expect(down.defaultPrevented).toBe(true);expect(document.activeElement).toBe(title);
  expect(container.querySelector('.recovery-panel')).toBeNull();expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(native.checkpointChapter).not.toHaveBeenCalled();expect(native.recoverChapter).not.toHaveBeenCalled();expect(native.listRecovery).toHaveBeenCalledTimes(calls);
  expect(container.textContent).toContain('请先完成中文输入');
});
it('keeps the current editor when its full recovery checkpoint cannot be retained', async () => {
  native.listRecovery.mockResolvedValue([recoveryRecord()]);native.checkpointChapter.mockRejectedValue(new Error('恢复位置不可写'));
  await act(async () => root.render(<App />));await editBody('不能切走的末句。');
  await openRecovery();
  expect(container.querySelector('.recovery-panel')).toBeNull();expect(container.querySelector('#chapter-body')?.textContent).toBe('不能切走的末句。');
  expect(container.textContent).toContain('恢复位置不可写');expect(native.recoverChapter).not.toHaveBeenCalled();expect(native.saveChapter).not.toHaveBeenCalled();
});
it('requires a refreshed preview after a stale recovery receipt and uses the new sequence on retry', async () => {
  const record=recoveryRecord();native.listRecovery.mockResolvedValue([record]);native.recoverChapter.mockRejectedValueOnce(new Error('预览后已有更新，请刷新'));
  await act(async () => root.render(<App />));await openRecovery();
  await act(async () => findButton('继续此版本').click());
  expect(container.querySelector('.recovery-panel')).not.toBeNull();expect(container.textContent).toContain('预览后已有更新');
  expect(container.querySelector('[aria-label="所选恢复草稿全文"]')?.textContent).toContain(record.draft.body);
  const updated={...record,sequence:4,draft:{...record.draft,body:'更新后应核对的完整末句。'}};
  native.listRecovery.mockResolvedValue([updated]);
  await act(async () => findButton('刷新恢复记录').click());
  expect(container.textContent).toContain(updated.draft.body);
  native.recoverChapter.mockResolvedValue({path:'C:/test-library',works:[{id:'work',title:'测试作品'}],chapter:{...chapter,body:updated.draft.body,revision:1}});
  await act(async () => findButton('继续此版本').click());
  expect(native.recoverChapter).toHaveBeenLastCalledWith(record.id,4,false);
});
it('reports unreadable recovery storage without inventing an empty successful scan', async () => {
  native.listRecovery.mockRejectedValue(new Error('恢复日志校验失败，文件已保留'));
  await act(async () => root.render(<App />));
  expect(container.textContent).toContain('恢复记录读取失败');expect(container.textContent).toContain('文件已保留');
  await openRecovery();
  expect(container.querySelector('.recovery-panel')).not.toBeNull();expect(container.textContent).toContain('暂时无法读取恢复记录');
  expect(container.textContent).not.toContain('没有需要处理的恢复草稿');expect(native.recoverChapter).not.toHaveBeenCalled();
});
