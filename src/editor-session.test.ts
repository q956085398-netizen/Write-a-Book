import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSession } from './editor-session';
import { characterCount, type Chapter, type SaveChapter } from './model';

const chapter: Chapter = { id:'chapter',contentId:'content',workId:'work',title:'第一章',body:'',revision:0 };
const receipt = (draft: SaveChapter): Chapter => ({ ...chapter,...draft,revision:draft.expectedRevision+1 });
const sessions: EditorSession[] = [];
function session(saveChapter: (draft: SaveChapter) => Promise<Chapter>) {
  const value = new EditorSession({saveChapter}); value.load(chapter); sessions.push(value); return value;
}
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); });
describe('author save and close boundary', () => {
  it('does not show saved until persistence acknowledges and includes later typing before close', async () => {
    let complete!: (value: Chapter) => void;
    const write = vi.fn<(draft: SaveChapter) => Promise<Chapter>>()
      .mockImplementationOnce(() => new Promise(resolve => { complete=resolve; }))
      .mockImplementation(async draft => receipt(draft));
    const editor = session(write);
    editor.edit('body','中文第一句');
    const closed = editor.flush();
    expect(editor.getSnapshot().status).toBe('saving');
    editor.edit('body','中文第一句\n继续输入');
    complete(receipt(write.mock.calls[0][0]));
    expect(await closed).toBe(true);
    expect(write.mock.calls[1][0]).toMatchObject({body:'中文第一句\n继续输入',expectedRevision:1});
    expect(editor.getSnapshot()).toMatchObject({status:'saved',chapter:{body:'中文第一句\n继续输入',revision:2}});
  });
  it('keeps input and blocks switching/close on failure, then allows an explicit retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('磁盘已满')).mockImplementation(async draft => receipt(draft));
    const editor = session(write);
    editor.edit('body','不能丢掉的文字');
    expect(await editor.flush()).toBe(false);
    expect(editor.getSnapshot()).toMatchObject({status:'error',error:'磁盘已满',chapter:{body:'不能丢掉的文字',revision:0}});
    expect(() => editor.load(null)).toThrow();
    expect(await editor.flush()).toBe(true);
    editor.load(null);
  });
  it('never saves uncommitted composition and saves its final value after compositionend', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async draft => receipt(draft));
    const editor = session(write);
    editor.beginComposition(); editor.edit('body','zhong');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await editor.flush()).toBe(false); expect(write).not.toHaveBeenCalled();
    editor.edit('body','中文'); editor.endComposition();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({body:'中文'}));
    expect(editor.getSnapshot().status).toBe('saved');
  });
  it('saves ongoing completed input at about five seconds without waiting for idle', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async draft => receipt(draft));
    const editor = session(write);
    for (let n=1;n<=10;n++) { editor.edit('body','字'.repeat(n)); await vi.advanceTimersByTimeAsync(500); }
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].body).toBe('字'.repeat(10));
  });
  it('does not postpone continuous Chinese input indefinitely across compositions', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async draft => receipt(draft));
    const editor = session(write);
    for (let n=1;n<=11;n++) {
      editor.beginComposition(); editor.edit('body','字'.repeat(n));
      await vi.advanceTimersByTimeAsync(450);
      editor.endComposition();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls[0][0].body.length).toBeGreaterThanOrEqual(10);
  });
  it('serializes concurrent save requests and preserves a title edit', async () => {
    const write = vi.fn(async draft => receipt(draft));
    const editor = session(write);
    editor.edit('title','第一章 雨'); editor.edit('body','下雨了。');
    expect(await Promise.all([editor.flush(),editor.flush()])).toEqual([true,true]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(editor.getSnapshot().chapter?.title).toBe('第一章 雨');
  });
  it('counts Unicode code points, excluding whitespace and including punctuation', () => {
    expect(characterCount(' 中文，\nA🙂　')).toBe(5);
  });
});
