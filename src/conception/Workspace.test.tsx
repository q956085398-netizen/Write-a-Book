// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConceptionController } from './controller';
import { ConceptionWorkspace } from './Workspace';
import { fixture } from './test-fixture';
import { documentText } from '../rich-content';
import { writeDocument } from '../rich-content';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let container:HTMLDivElement;
let root:ReturnType<typeof createRoot>;
let c:ConceptionController;
// jsdom supplies DOM editing but no text-range geometry; these zeros are not visual evidence.
Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:() => []});
Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:() => new DOMRect()});
beforeEach(() => {container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async () => {await act(async () => root.unmount());container.remove();c?.dispose();});
const button=(name:string,within:ParentNode=container) => Array.from(within.querySelectorAll('button')).find(button => button.textContent===name)!;
async function click(name:string,within:ParentNode=container) {await act(async () => {button(name,within).click();});}
async function input(element:HTMLInputElement,value:string) {
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}
it('author can create and directly write Chinese, then hide, open and restore a section through settings without losing the shared record',async () => {
  const {port,views}=fixture();c=new ConceptionController(port);await c.openWork('a');
  await act(async () => root.render(<ConceptionWorkspace controller={c} onReturn={() => {}}/>));
  expect(container.textContent).toContain('当前书');expect(container.querySelector('details')?.hasAttribute('open')).toBeFalsy();
  await click('新建构思');
  const body=container.querySelector('#conception-body')!;
  expect(body).not.toBeNull();expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
  await act(async () => {
    body.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));body.querySelector('p')!.textContent='zhongwen';
    await new Promise(resolve => setTimeout(resolve,30));
  });
  await act(async () => {expect(await c.flush()).toBe(false);});
  await act(async () => {
    body.querySelector('p')!.textContent='结尾，她决定留下。';body.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'结尾，她决定留下。'}));
    await new Promise(resolve => setTimeout(resolve,30));expect(await c.flush()).toBe(true);
  });
  expect(documentText(views.a.records[0])).toBe('结尾，她决定留下。');
  await click('分区管理');
  const current=container.querySelector('.conception-settings section')!;
  expect(current.textContent).toContain('当前作品 · 当前书');
  await act(async () => (current.querySelector('input[type=checkbox]') as HTMLInputElement).click());
  await click('保存分区设置');
  await click('打开内容',current);
  expect(container.querySelector('.conception-hidden')?.textContent).toContain('已隐藏');
  expect(container.querySelector('.conception-directory')?.textContent).not.toContain('故事核心');
  expect(views.a.sections[0].hidden).toBe(true);
  await click('未命名构思',container.querySelector('.conception-hidden-list')!);
  expect(container.querySelector('#conception-body')?.textContent).toBe('结尾，她决定留下。');
  expect(views.a.records).toHaveLength(1);
  await click('分区管理');
  const restored=container.querySelector('.conception-settings section')!;
  await act(async () => (restored.querySelector('input[type=checkbox]') as HTMLInputElement).click());
  await click('保存分区设置');await click('返回构思',container.querySelector('.conception-settings')!);
  expect(container.querySelector('.conception-directory')?.textContent).toContain('故事核心');expect(views.a.sections[0].hidden).toBe(false);
});
it('settings clearly separate this book from future library works and leave errors visible with editable inputs',async () => {
  const {port}=fixture();c=new ConceptionController(port);await c.openWork('a');await c.openSettings();
  await act(async () => root.render(<ConceptionWorkspace controller={c} onReturn={() => {}}/>));
  expect(container.textContent).toContain('仅用于当前资料库中以后创建的新作品，已有作品保持原配置');
  const inputElement=container.querySelector<HTMLInputElement>('.conception-section-rows input')!;
  await input(inputElement,'');await click('保存分区设置');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('不能为空');
  expect(inputElement.value).toBe('');expect(inputElement.disabled).toBe(false);
  await click('撤回未保存修改');expect(inputElement.value).toBe('故事核心');
  const defaultsSection=container.querySelectorAll('.conception-settings section')[1];
  await click('移除',defaultsSection);await click('添加分区',defaultsSection);
  await input(defaultsSection.querySelector('input:not([type=checkbox])')!,'独立的新书候选');
  await click('保存分区设置');
  expect((await port.defaults()).sections[0].name).toBe('独立的新书候选');
  expect(c.getSnapshot().view?.sections[0].name).toBe('故事核心');
});
it('full recovery comparison renders final text and managed images and offers a copy when current versions conflict',async () => {
  const {port}=fixture();c=new ConceptionController(port);await c.openWork('a');await c.create();
  const base={...c.getSnapshot().editor.chapter!,bodyFormat:'plain-text'};
  const body=writeDocument({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'完整长构思。'.repeat(1600)}]},{type:'managedImage',attrs:{attachmentId:'12345678-1234-1234-1234-123456789abc',alt:'构思图'}},{type:'paragraph',content:[{type:'text',text:'不可截掉的最后一句。'}]}]});
  const candidate={id:'recovery',sequence:2,base,current:{...base,body:'另一个完整版本',revision:1},draft:{id:base.id,contentId:base.contentId,title:'冲突草稿',body,bodyFormat:'wab-rich-v1',expectedRevision:0},conflict:true,integrityError:null};
  vi.mocked(port.listRecovery).mockResolvedValue([candidate]);await c.showRecovery();
  await act(async () => root.render(<ConceptionWorkspace controller={c} onReturn={() => {}}/>));
  expect(container.querySelector('[aria-label="构思恢复草稿全文"]')?.textContent).toContain('不可截掉的最后一句。');
  expect(container.querySelector('[aria-label="资料库当前构思全文"]')?.textContent).toBe('另一个完整版本');
  expect(port.readImage).toHaveBeenCalledWith(base.contentId,'12345678-1234-1234-1234-123456789abc');
  expect(button('继续此版本')).toBeUndefined();expect(button('另存构思副本').disabled).toBe(false);
  expect(port.recover).not.toHaveBeenCalled();
});
