// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Chapter, RecoveryCandidate } from './model';
import { application } from './application';
import { RecoveryPanel, RecoveryPreview } from './RecoveryPanel';
import { writeDocument } from './rich-content';
vi.mock('./application', () => ({ application: { readImage: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const current: Chapter = { id:'chapter', contentId:'current-content', workId:'work', title:'当前章', body:'当前正文完整末句。', revision:0 };
function candidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return { id:'record', sequence:7, base:current, current, draft:{ id:current.id, contentId:current.contentId, title:'恢复草稿', body:'草稿末句。', expectedRevision:0 }, conflict:false, integrityError:null, ...overrides };
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container=document.createElement('div');document.body.append(container);root=createRoot(container);vi.mocked(application.readImage).mockReset(); });
afterEach(async () => { await act(async () => root.unmount());container.remove(); });
function button(text: string) { return Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)!; }
function render(candidates: RecoveryCandidate[], onRecover=vi.fn(), error: string | null = null) {
  return <RecoveryPanel current={current} candidates={candidates} error={error} busy={false} onRecover={onRecover} onReturn={() => {}} onRefresh={() => {}}/>;
}
it('shows both complete long manuscripts and uses the exact safe candidate only after an explicit choice', async () => {
  const long='逐行核对。\n'.repeat(1400)+'草稿的最后一句。';
  const record=candidate({ draft:{ ...candidate().draft, body:long } });
  const recover=vi.fn();
  await act(async () => root.render(render([record],recover)));
  expect(container.querySelector('[aria-label="当前窗口正文全文"]')?.textContent).toContain(current.body);
  const preview=container.querySelector('[aria-label="所选恢复草稿全文"]')!;
  expect(preview.textContent).toContain('草稿的最后一句。');
  expect(preview.querySelectorAll('p').length).toBeGreaterThan(1400);
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(recover).not.toHaveBeenCalled();
  await act(async () => button('继续此版本').click());
  expect(recover).toHaveBeenCalledWith(record,false);
  await act(async () => button('另存恢复作品').click());
  expect(recover).toHaveBeenLastCalledWith(record,true);
});
it('keeps ambiguous versions visible and offers only a copy, while invalid drafts cannot be applied', async () => {
  const ambiguous=candidate({ id:'ambiguous', conflict:true, current:{...current, body:'资料库中的另一完整版本。', revision:2} });
  const invalid=candidate({ id:'invalid', integrityError:'图片依赖缺失' });
  const recover=vi.fn();
  await act(async () => root.render(render([ambiguous,invalid],recover)));
  expect(container.textContent).toContain('版本先后不明');expect(button('继续此版本')).toBeUndefined();
  expect(container.querySelector('[aria-label="资料库当前版本全文"]')?.textContent).toContain('资料库中的另一完整版本。');
  await act(async () => button('另存恢复作品').click());expect(recover).toHaveBeenCalledWith(ambiguous,true);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.recovery-record')[1].click());
  expect(container.textContent).toContain('完整性未确认');expect(container.textContent).toContain('图片依赖缺失');
  expect(button('另存恢复作品').disabled).toBe(true);expect(button('继续此版本')).toBeUndefined();
  expect(container.querySelector('[aria-label="所选恢复草稿全文"]')?.textContent).toContain('草稿末句。');
});
it('preserves unrecognized bodies verbatim and read-only without enabling recovery', async () => {
  const raw='{"future":true,"unrecognized":"原文末尾"}';
  const record=candidate({ draft:{...candidate().draft,body:raw,bodyFormat:'future-v3'} });
  await act(async () => root.render(render([record])));
  const retained=container.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(retained.readOnly).toBe(true);expect(retained.value).toBe(raw);
  expect(container.textContent).toContain('原始正文只读保留');expect(button('另存恢复作品').disabled).toBe(true);
  expect(button('继续此版本')).toBeUndefined();
});
it('renders managed images, formatting and the final paragraph without editing, then reads a copied image under its new content identity', async () => {
  const oldImage='12345678-1234-1234-1234-123456789abc';
  const newImage='87654321-1234-1234-1234-123456789abc';
  const body=(id: string) => writeDocument({type:'doc',content:[
    {type:'paragraph',content:[{type:'text',text:'加粗文字',marks:[{type:'bold'}]}]},
    {type:'managedImage',attrs:{attachmentId:id,alt:'本地插图'}},
    {type:'paragraph',content:[{type:'text',text:'图片后的完整末段。'}]},
  ]});
  vi.mocked(application.readImage).mockResolvedValue('data:image/png;base64,AA==');
  await act(async () => root.render(<RecoveryPreview content={{...current,body:body(oldImage),bodyFormat:'wab-rich-v1'}} label="全文"/>));
  expect(container.querySelector('strong')?.textContent).toBe('加粗文字');
  expect(container.querySelector('img')?.alt).toBe('本地插图');expect(container.textContent).toContain('图片后的完整末段。');
  expect(application.readImage).toHaveBeenCalledWith('current-content',oldImage);
  await act(async () => root.render(<RecoveryPreview content={{...current,contentId:'recovered-copy-content',body:body(newImage),bodyFormat:'wab-rich-v1'}} label="全文"/>));
  expect(application.readImage).toHaveBeenLastCalledWith('recovered-copy-content',newImage);
  expect(application.readImage).not.toHaveBeenCalledWith('recovered-copy-content',oldImage);
});
it('ignores an obsolete image read and retains all text when the selected image fails', async () => {
  let resolveOld!: (value: string) => void;
  vi.mocked(application.readImage).mockImplementationOnce(() => new Promise(resolve => {resolveOld=resolve;})).mockRejectedValueOnce(new Error('受管图片无法读取'));
  const body=writeDocument({type:'doc',content:[{type:'managedImage',attrs:{attachmentId:'12345678-1234-1234-1234-123456789abc',alt:'插图'}},{type:'paragraph',content:[{type:'text',text:'不受图片错误影响的末句。'}]}]});
  await act(async () => root.render(<RecoveryPreview content={{...current,body,bodyFormat:'wab-rich-v1'}} label="全文"/>));
  await act(async () => root.render(<RecoveryPreview content={{...current,contentId:'next-content',body,bodyFormat:'wab-rich-v1'}} label="全文"/>));
  await act(async () => resolveOld('data:image/png;base64,OLD'));
  expect(container.querySelector('img')).toBeNull();expect(container.textContent).toContain('受管图片无法读取');expect(container.textContent).toContain('不受图片错误影响的末句。');
});
it('uses refreshed sequence data, keeps both previews on an error, and reports an empty list honestly', async () => {
  const recover=vi.fn();const record=candidate();
  await act(async () => root.render(render([record],recover)));
  const updated={...record,sequence:8,draft:{...record.draft,body:'刷新后的完整末句。'}};
  await act(async () => root.render(render([updated],recover,'预览后已有更新')));
  expect(container.textContent).toContain(current.body);expect(container.textContent).toContain('刷新后的完整末句。');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('当前内容与原恢复记录继续保留');
  await act(async () => button('继续此版本').click());expect(recover).toHaveBeenCalledWith(updated,false);
  await act(async () => root.render(render([])));
  expect(container.textContent).toContain('没有需要处理的恢复草稿');expect(button('继续此版本')).toBeUndefined();
});
