// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Chapter, LibraryView, SaveChapter } from './model';

const port = vi.hoisted(() => ({ bootstrap:vi.fn(), libraryView:vi.fn(), selectWork:vi.fn(), selectEntry:vi.fn(), createWork:vi.fn(), changeStructure:vi.fn(), saveChapter:vi.fn(), checkpointChapter:vi.fn(), acknowledgeRecovery:vi.fn(), listRecovery:vi.fn(), readImage:vi.fn() }));
const native = vi.hoisted(() => ({ destroy:vi.fn(), close:(_event:{preventDefault:()=>void})=>{} }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri:()=>true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow:()=>({ destroy:native.destroy, onCloseRequested:async(handler:typeof native.close)=>{native.close=handler;return()=>{};} }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open:vi.fn() }));
vi.mock('./application', () => ({ application:port }));
import App from './App';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
// JSDOM has no text layout; provide geometry only for ProseMirror's focus/scroll boundary.
Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
let host:HTMLDivElement, root:ReturnType<typeof createRoot>, initial:LibraryView;
const fragment:Chapter={ id:'fragment-a', contentId:'fragment-content', workId:'work-a', title:'雨后的片段', body:'先写的正文。', bodyFormat:'plain-text', revision:4 };
function fixture():LibraryView {
  return { path:'C:/synthetic-library', works:[
    {id:'work-a',title:'暂名甲',structureRevision:7,lastEntry:{id:fragment.id,title:fragment.title,kind:'fragment'}},
    {id:'work-b',title:'暂名乙',structureRevision:2,lastEntry:{id:'chapter-b',title:'乙的最后一章',kind:'chapter'}},
  ], chapter:{...fragment}, entries:[
    {id:'chapter-a',contentId:'chapter-content',title:'第一章',kind:'chapter',volumeId:null,position:0},
    {id:'chapter-a2',contentId:'chapter-content-2',title:'第二章',kind:'chapter',volumeId:'volume-a',position:0},
    {id:fragment.id,contentId:fragment.contentId,title:fragment.title,kind:'fragment',volumeId:null,position:0},
  ], volumes:[{id:'volume-a',title:'上卷',position:1},{id:'volume-b',title:'下卷',position:2}] };
}
beforeEach(() => {
  vi.useFakeTimers();Object.values(port).forEach(mock=>mock.mockReset());native.destroy.mockReset();
  initial=fixture();port.bootstrap.mockImplementation(async()=>({defaultPath:initial.path,library:initial,restoreError:null}));
  port.libraryView.mockImplementation(async()=>initial);port.listRecovery.mockResolvedValue([]);port.checkpointChapter.mockResolvedValue(undefined);port.acknowledgeRecovery.mockResolvedValue(undefined);
  port.saveChapter.mockImplementation(async(draft:SaveChapter)=>({...fragment,...draft,revision:draft.expectedRevision+1}));
  port.readImage.mockResolvedValue('data:image/png;base64,c3ludGhldGlj');
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
function button(name:string, scope:ParentNode=host) { const result=Array.from(scope.querySelectorAll('button')).find(item=>item.textContent===name || item.getAttribute('aria-label')===name);expect(result, name).toBeDefined();return result!; }
async function click(name:string,scope:ParentNode=host) {await act(async()=>button(name,scope).click());}
async function value(selector:string,text:string) {const node=host.querySelector<HTMLInputElement|HTMLSelectElement>(selector)!;await act(async()=>{Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(node,text);node.dispatchEvent(new Event(node instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});}
async function edit(text:string) {const body=host.querySelector<HTMLElement>('#chapter-body')!;await act(async()=>{body.querySelector('p')!.textContent=text;body.dispatchEvent(new Event('input',{bubbles:true}));await vi.advanceTimersByTimeAsync(20);});return body;}

it('shows the same real continue positions on the shelf and compact list, then opens the chosen work',async()=>{
  await act(async()=>root.render(<App/>));await click('作品书架');
  expect(port.libraryView).toHaveBeenCalledOnce();expect(host.querySelector('.works-home')?.textContent).toContain('未编章片段 · 雨后的片段');
  expect(host.querySelector('.works-home')?.textContent).toContain('章节 · 乙的最后一章');
  await click('紧凑列表');expect(host.querySelector('.works-collection.list')).not.toBeNull();
  expect(host.querySelectorAll('.work-card')).toHaveLength(2);expect(host.querySelector('.works-home')?.textContent).toContain('雨后的片段');
  const other:Chapter={...fragment,id:'chapter-b',workId:'work-b',contentId:'other-content',title:'乙的最后一章',body:'乙作品独立正文。'};
  port.selectWork.mockResolvedValue({...initial,chapter:other,volumes:[],entries:[{id:other.id,contentId:other.contentId,title:other.title,kind:'chapter',volumeId:null,position:0}]});
  await click('继续创作 暂名乙');expect(port.selectWork).toHaveBeenCalledWith('work-b');
  expect(host.querySelector('#chapter-body')?.textContent).toBe(other.body);expect(host.querySelector('.works-home')).toBeNull();
  await click('作品书架');await click('新建作品');expect(host.querySelector('#work-title')).not.toBeNull();expect(host.querySelector('.works-home')).toBeNull();
});
it('does not create a fragment before the current complete body receives a real save receipt',async()=>{
  await act(async()=>root.render(<App/>));await edit('当前片段最后一句。');
  port.saveChapter.mockRejectedValueOnce(new Error('受控主库不可写'));
  await click('＋ 新建片段');expect(host.querySelector('[role="dialog"]')).toBeNull();expect(port.changeStructure).not.toHaveBeenCalled();
  expect(host.querySelector('#chapter-body')?.textContent).toBe('当前片段最后一句。');
  await click('＋ 新建片段');expect(port.saveChapter).toHaveBeenCalledTimes(2);expect(port.checkpointChapter).toHaveBeenCalled();
  await value('#structure-title','结局先写');
  const next={...fragment,id:'new-fragment',contentId:'new-content',title:'结局先写',body:'',revision:0};
  port.changeStructure.mockResolvedValue({...initial,chapter:next,entries:[...initial.entries!,{id:next.id,contentId:next.contentId,title:next.title,kind:'fragment',volumeId:null,position:1}]});
  await click('保存并继续');
  expect(port.changeStructure).toHaveBeenCalledWith({type:'createEntry',workId:'work-a',expectedRevision:7,kind:'fragment',title:'结局先写',volumeId:null});
  expect(host.querySelector<HTMLInputElement>('#chapter-title')?.value).toBe('结局先写');expect(host.querySelector('#chapter-body')?.getAttribute('aria-label')).toBe('片段正文');
  await edit('新片段的完整末句。');await click('保存');
  expect(port.saveChapter.mock.calls.at(-1)?.[0]).toMatchObject({id:'new-fragment',contentId:'new-content'});
});
it('confirms compiling the same rich fragment, retains its image identity, and leaves no fragment duplicate',async()=>{
  const rich=JSON.stringify({format:'write-a-book',version:1,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'保留末句。'}]},{type:'managedImage',attrs:{attachmentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',alt:'原片段图片'}}]}});
  initial={...initial,chapter:{...fragment,body:rich,bodyFormat:'wab-rich-v1'}};
  await act(async()=>root.render(<App/>));expect(port.readImage).toHaveBeenCalledWith('fragment-content','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await click('编为新章节');const dialog=host.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('不会留下重复正文');
  await value('#structure-parent','volume-a');await value('#structure-before','chapter-a2');
  port.changeStructure.mockResolvedValue({...initial,entries:initial.entries!.map(entry=>entry.id===fragment.id?{...entry,kind:'chapter',volumeId:'volume-a',position:0}:entry.id==='chapter-a2'?{...entry,position:1}:entry)});
  await click('确认编为新章节');expect(port.changeStructure).toHaveBeenCalledWith({type:'compileFragment',workId:'work-a',expectedRevision:7,id:fragment.id,volumeId:'volume-a',beforeId:'chapter-a2'});
  expect(port.saveChapter).not.toHaveBeenCalled();expect(host.querySelector('#chapter-body')?.textContent).toContain('保留末句。');
  expect(host.querySelector('#chapter-body')?.getAttribute('aria-label')).toBe('章节正文');expect(host.querySelector('img')?.getAttribute('alt')).toBe('原片段图片');
  expect(host.querySelector('[aria-label="未编章片段"]')?.textContent).not.toContain(fragment.title);
  expect(host.querySelector('[aria-label="卷章目录"]')?.textContent).toContain(fragment.title);
});
it('keeps a failed structure transaction and its dialog visible until the author retries',async()=>{
  await act(async()=>root.render(<App/>));await click('编为新章节');
  port.changeStructure.mockRejectedValueOnce(new Error('受控目录事务失败，原目录保留'));
  await click('确认编为新章节');expect(host.querySelector('[role="dialog"]')?.textContent).toContain('原目录保留');
  expect(host.querySelector('[aria-label="未编章片段"]')?.textContent).toContain(fragment.title);expect(host.querySelector('#chapter-body')?.textContent).toBe(fragment.body);
  port.changeStructure.mockResolvedValue({...initial,entries:initial.entries!.map(entry=>entry.id===fragment.id?{...entry,kind:'chapter',position:3}:entry)});
  await click('确认编为新章节');expect(port.changeStructure).toHaveBeenCalledTimes(2);expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('[aria-label="未编章片段"]')?.textContent).not.toContain(fragment.title);
});
it('moves a volume and a chapter with explicit sibling positions and the work revision',async()=>{
  await act(async()=>root.render(<App/>));port.changeStructure.mockResolvedValue(initial);
  await click('上移 下卷');expect(port.changeStructure).toHaveBeenLastCalledWith({type:'move',workId:'work-a',expectedRevision:7,id:'volume-b',volumeId:null,beforeId:'volume-a'});
  await click('整理 第一章');await value('#structure-parent','volume-a');await value('#structure-before','chapter-a2');await click('确认移动');
  expect(port.changeStructure).toHaveBeenLastCalledWith({type:'move',workId:'work-a',expectedRevision:7,id:'chapter-a',volumeId:'volume-a',beforeId:'chapter-a2'});
});
it('keeps the current composition focused when a T05 structure action is requested',async()=>{
  await act(async()=>root.render(<App/>));const title=host.querySelector<HTMLInputElement>('#chapter-title')!;
  await act(async()=>{title.focus();title.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));});
  const down=new MouseEvent('mousedown',{bubbles:true,cancelable:true});await act(async()=>{button('＋ 新建片段').dispatchEvent(down);button('＋ 新建片段').click();});
  expect(down.defaultPrevented).toBe(true);expect(document.activeElement).toBe(title);expect(host.querySelector('[role="dialog"]')).toBeNull();expect(port.changeStructure).not.toHaveBeenCalled();expect(port.saveChapter).not.toHaveBeenCalled();
});
it('protects an unfinished directory name from a native close request',async()=>{
  await act(async()=>root.render(<App/>));await click('＋ 新建分卷');await value('#structure-title','尚未保存的卷名');
  await act(async()=>native.close({preventDefault:vi.fn()}));expect(native.destroy).not.toHaveBeenCalled();expect(host.querySelector<HTMLInputElement>('#structure-title')?.value).toBe('尚未保存的卷名');
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('请先保存或取消');
});
