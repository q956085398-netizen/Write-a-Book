// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SaveChapter } from './model';

const chapter = { id: 'chapter', contentId: 'content', workId: 'work', title: '第一章', body: '', revision: 0 };
const native = vi.hoisted(() => ({ saveChapter: vi.fn(), checkpointChapter: vi.fn(), destroy: vi.fn(), close: (_event: {preventDefault: () => void}) => {} }));
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
    checkpointChapter: native.checkpointChapter, acknowledgeRecovery: async () => {}, listRecovery: async () => [],
  },
}));
import App from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();native.saveChapter.mockReset();native.checkpointChapter.mockReset();native.checkpointChapter.mockResolvedValue(undefined);native.destroy.mockReset();
  native.destroy.mockResolvedValue(undefined);
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
