// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Chapter, LibraryView } from './model';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
const port = vi.hoisted(() => ({ bootstrap:vi.fn(), listRecovery:vi.fn(), saveChapter:vi.fn(), checkpointChapter:vi.fn(), acknowledgeRecovery:vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri:()=>true, invoke:native.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow:()=>({ onCloseRequested:async()=>()=>{},destroy:vi.fn() }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open:vi.fn() }));
vi.mock('./application', () => ({ application:port }));
import App from './App';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
const chapter:Chapter={id:'chapter',contentId:'body',workId:'work',title:'标题不能算入字数',body:'中文，Ab 12😀',bodyFormat:'plain-text',revision:3};
const library:LibraryView={path:'C:/fictional-counts',works:[{id:'work',title:'字数验收',structureRevision:5,lastEntry:{id:'chapter',title:chapter.title,kind:'chapter'}}],chapter,volumes:[],entries:[
  {id:'chapter',contentId:'body',title:chapter.title,kind:'chapter',volumeId:null,position:0},
  {id:'second',contentId:'other',title:'另一个不计标题',kind:'chapter',volumeId:null,position:1},
  {id:'fragment',contentId:'fragment-body',title:'片段标题',kind:'fragment',volumeId:null,position:0},
]};
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{
  vi.useFakeTimers();native.invoke.mockReset();Object.values(port).forEach(mock=>mock.mockReset());
  port.bootstrap.mockResolvedValue({defaultPath:library.path,library,restoreError:null});port.listRecovery.mockResolvedValue([]);
  native.invoke.mockResolvedValue({workId:'work',structureRevision:5,contents:[{contentId:'body',kind:'chapter',revision:3,count:8},{contentId:'other',kind:'chapter',revision:1,count:4},{contentId:'fragment-body',kind:'fragment',revision:0,count:6}]});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
it('shows real scoped totals and overlays unsaved edits, selection and undo exactly once',async()=>{
  await act(async()=>root.render(<App/>));
  const footer=()=>host.querySelector('.editor-footer')?.textContent;
  expect(native.invoke).toHaveBeenCalledWith('character_counts',{workId:'work'});
  expect(footer()).toContain('当前章节 8');expect(footer()).toContain('全书章节 12');expect(footer()).toContain('未编章片段 6');
  const editor=(host.querySelector('#chapter-body') as HTMLElement & {editor:Editor}).editor;
  await act(async()=>{editor.commands.selectAll();});expect(footer()).toContain('选区 8');
  await act(async()=>{editor.commands.setTextSelection(1);editor.commands.insertContent('增');});
  expect(footer()).toContain('当前章节 9');expect(footer()).toContain('全书章节 13');expect(port.saveChapter).not.toHaveBeenCalled();
  await act(async()=>{editor.commands.undo();});expect(footer()).toContain('当前章节 8');expect(footer()).toContain('全书章节 12');
});
it('keeps current and selection counts when native aggregate reading fails',async()=>{
  native.invoke.mockRejectedValue(new Error('受控读取失败'));
  await act(async()=>root.render(<App/>));
  expect(host.querySelector('.editor-footer')?.textContent).toContain('当前章节 8');
  expect(host.querySelector('.editor-footer')?.textContent).toContain('全书章节 暂不可用');
  expect(host.querySelector('.editor-footer')?.textContent).toContain('未编章片段 暂不可用');
});
