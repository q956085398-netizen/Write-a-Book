// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SaveChapter } from './model';

const chapter = { id: 'chapter', contentId: 'content', workId: 'work', title: '第一章', body: '', revision: 0 };
const native = vi.hoisted(() => ({ saveChapter: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./application', () => ({
  application: {
    bootstrap: async () => ({
      defaultPath: 'C:/test-library', restoreError: null,
      library: { path: 'C:/test-library', works: [{ id: 'work', title: '测试作品' }], chapter },
    }),
    saveChapter: native.saveChapter,
  },
}));
import App from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
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
  const body = container.querySelector<HTMLTextAreaElement>('#chapter-body')!;
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body, text);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await type('保存失败也要保留。');
  const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存')!;
  await act(async () => { save.click(); await vi.advanceTimersByTimeAsync(0); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('磁盘已满');
  expect(body.value).toBe('保存失败也要保留。');

  await type('保存失败也要保留。继续写。');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(native.saveChapter).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('已保存到本地');
  expect(body.value).toBe('保存失败也要保留。继续写。');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
