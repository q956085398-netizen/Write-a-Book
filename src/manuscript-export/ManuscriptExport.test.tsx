// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManuscriptExport } from './ManuscriptExport';
import type { ExportManifest, ExportPort } from './export-port';
const manifest: ExportManifest = { workId: 'w', title: '测试作品', structureRevision: 3, chapters: [{ id: 'c', contentId: 'body', title: '第一章', volumeTitle: null, volumeId: null }], fragments: [{ id: 'f', contentId: 'fragment-body', title: '正文片段', volumeTitle: null, volumeId: null }] };
const fixtures: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });
async function setup(currentEntryId = 'c', flush = vi.fn(async () => {})) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const activity = vi.fn();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const port: ExportPort = { manifest: vi.fn(async () => manifest), chooseTarget: vi.fn(async () => 'C:/中文书稿.docx'), export: vi.fn(async () => ({ path: 'C:/中文书稿.docx', bytes: 1234, chapterCount: 1, fragmentCount: 0, imageCount: 0, structureRevision: 3, contentRevisions: [] })) };
  await act(async () => { root.render(<ManuscriptExport workId="w" currentEntryId={currentEntryId} port={port} beforeExport={flush} onActivityChange={activity} onClose={() => {}}/>); });
  fixtures.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  const click = async (element: HTMLElement) => { await act(async () => element.click()); };
  activity.mockClear();
  return { host, port, button, click, flush, activity };
}
describe('author-visible export result', () => {
  it('notifies activity synchronously across the save barrier and durable export', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.fn(() => pending);
    const { port, button, click, activity } = await setup('c', flush);
    await click(button('选择导出位置')); activity.mockClear();
    await click(button('确认导出'));
    expect(activity.mock.calls).toEqual([[true]]); expect(port.export).not.toHaveBeenCalled();
    expect(button('正在处理…').disabled).toBe(true);
    await act(async () => { release(); await pending; });
    expect(activity.mock.calls).toEqual([[true], [false]]); expect(port.export).toHaveBeenCalledTimes(1);
  });
  it('offers a directory retry after failure and clears fragment anchors on reload', async () => {
    const { host, port, button, click } = await setup();
    const fragment = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(input => input.parentElement?.textContent === '正文片段')!;
    await click(fragment); expect(host.querySelector('select')).not.toBeNull();
    vi.mocked(port.manifest).mockRejectedValueOnce(new Error('目录读取失败'));
    await click(button('重新读取目录'));
    expect(host.querySelector('[role=alert]')?.textContent).toContain('目录读取失败');
    expect(button('重新读取目录').disabled).toBe(false);
    await click(button('重新读取目录'));
    expect(host.querySelector('select')).toBeNull(); expect(host.textContent).toContain('本次范围：1 章，0 个主动片段');
  });
  it('requires active fragment selection and position instead of defaulting current chapter', async () => {
    const { host } = await setup('f');
    const current = [...host.querySelectorAll<HTMLInputElement>('input[type=radio]')].find(input => input.parentElement?.textContent === '当前章')!;
    expect(current.disabled).toBe(true);
    expect(host.textContent).toContain('本次范围：0 章，0 个主动片段');
    expect(host.querySelector('select')).toBeNull();
  });
  it('shows a failure with no success receipt, then gives the actual durable receipt after retry', async () => {
    const { host, port, button, click, flush } = await setup();
    vi.mocked(port.export).mockRejectedValueOnce(new Error('目标被锁定，原文件已保留'));
    await click(button('选择导出位置')); await click(button('确认导出'));
    expect(flush).toHaveBeenCalledTimes(1); expect(host.querySelector('[role=alert]')?.textContent).toContain('目标被锁定'); expect(host.textContent).not.toContain('书稿已写入文件');
    await click(button('确认导出'));
    expect(host.textContent).toContain('书稿已写入文件'); expect(host.textContent).toContain('C:/中文书稿.docx');
    expect(host.querySelector('[role=alert]')).toBeNull();
    expect(vi.mocked(port.export).mock.calls[1][0]).toMatchObject({ expectedStructureRevision: 3, scope: { type: 'current', entryId: 'c' }, fragments: [], replaceExisting: false });
  });
  it('never exports when the save barrier fails', async () => {
    const flush = vi.fn(async () => { throw new Error('正文尚未保存'); });
    const { host, port, button, click } = await setup('c', flush);
    await click(button('选择导出位置')); await click(button('确认导出'));
    expect(port.export).not.toHaveBeenCalled(); expect(host.querySelector('[role=alert]')?.textContent).toContain('正文尚未保存'); expect(host.textContent).not.toContain('书稿已写入文件');
  });
});
