// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import type { ConceptionPort } from './conception/types';
import { fixture } from './conception/test-fixture';
const concept=vi.hoisted(()=>({} as ConceptionPort));
const port=vi.hoisted(()=>({bootstrap:vi.fn(),listRecovery:vi.fn(),selectWork:vi.fn(),saveChapter:vi.fn(),checkpointChapter:vi.fn(),acknowledgeRecovery:vi.fn()}));
const exporting=vi.hoisted(()=>({manifest:vi.fn(),chooseTarget:vi.fn(),export:vi.fn()}));
const native=vi.hoisted(()=>({destroy:vi.fn(),close:(_e:{preventDefault:()=>void})=>{}}));
vi.mock('./application',()=>({application:port}));
vi.mock('./conception/port',()=>({conceptionPort:concept}));
vi.mock('./manuscript-export/native-port',()=>({nativeExportPort:exporting}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn().mockRejectedValue(new Error('no aggregate fixture'))}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:vi.fn()}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({destroy:native.destroy,onCloseRequested:async(handler:typeof native.close)=>{native.close=handler;return()=>{};}})}));
import App from './App';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){this.open=true;}});
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{
  vi.useFakeTimers();Object.assign(concept,fixture().port);Object.values(port).forEach(mock=>mock.mockReset());Object.values(exporting).forEach(mock=>mock.mockReset());native.destroy.mockReset();
  const chapter={id:'chapter-a',contentId:'body-a',workId:'a',title:'原正文',body:'正文独立保留。',revision:0,bodyFormat:'plain-text'};
  port.bootstrap.mockResolvedValue({defaultPath:'C:/fixture',library:{path:'C:/fixture',works:[{id:'a',title:'当前书',structureRevision:0,lastEntry:{id:chapter.id,title:chapter.title,kind:'chapter'}}],chapter,entries:[{id:chapter.id,contentId:chapter.contentId,title:chapter.title,kind:'chapter',volumeId:null,position:0}],volumes:[]},restoreError:null});port.listRecovery.mockResolvedValue([]);
  exporting.manifest.mockResolvedValue({workId:'a',title:'当前书',structureRevision:0,chapters:[{id:chapter.id,contentId:chapter.contentId,title:chapter.title,volumeTitle:null,volumeId:null}],fragments:[]});exporting.chooseTarget.mockResolvedValue('C:/fictional-manuscript.docx');
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
async function click(text:string){const button=Array.from(host.querySelectorAll('button')).find(button=>button.textContent===text)!;expect(button,text).toBeDefined();await act(async()=>button.click());}
it('keeps unsaved conception on failed return and native close, then saves before returning to the unchanged manuscript',async()=>{
  await act(async()=>root.render(<App/>));await click('构思');await click('新建构思');
  const editor=(host.querySelector('#conception-body') as HTMLElement & {editor:Editor}).editor;
  await act(async()=>{editor.commands.insertContent('构思最后一句。');});
  vi.mocked(concept.save).mockRejectedValue(new Error('受控构思不可写'));
  await click('返回正文');expect(host.querySelector('#conception-body')?.textContent).toBe('构思最后一句。');expect(host.querySelector('#chapter-body')).toBeNull();
  await act(async()=>native.close({preventDefault:()=>{}}));expect(native.destroy).not.toHaveBeenCalled();expect(host.querySelector('[role=alertdialog]')?.textContent).toContain('关闭前，还有内容未保存');
  await click('继续编辑');
  vi.mocked(concept.save).mockImplementation(async draft=>({...draft,workId:'a',bodyFormat:draft.bodyFormat??'plain-text',revision:1}));
  await click('返回正文');expect(host.querySelector('#chapter-body')?.textContent).toBe('正文独立保留。');expect(port.saveChapter).not.toHaveBeenCalled();expect(concept.checkpoint).toHaveBeenCalled();
});
it('blocks native close throughout the real export promise and allows close only after the receipt',async()=>{
  let release!:(value:unknown)=>void;const pending=new Promise(resolve=>{release=resolve;});exporting.export.mockReturnValue(pending);
  await act(async()=>root.render(<App/>));await click('导出书稿');await click('选择导出位置');await click('确认导出');
  await act(async()=>native.close({preventDefault:()=>{}}));expect(native.destroy).not.toHaveBeenCalled();expect(host.querySelector('dialog')?.textContent).toContain('导出操作正在进行');
  await act(async()=>{release({path:'C:/fictional-manuscript.docx',bytes:100,chapterCount:1,fragmentCount:0,imageCount:0,structureRevision:0,contentRevisions:[]});await pending;});
  expect(host.querySelector('dialog')?.textContent).toContain('书稿已写入文件');
  await act(async()=>native.close({preventDefault:()=>{}}));expect(native.destroy).toHaveBeenCalledOnce();
});
