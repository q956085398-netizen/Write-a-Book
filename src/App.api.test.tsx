// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ destroy:vi.fn(), close:(_event:{preventDefault:()=>void})=>{} }));
const api = vi.hoisted(() => ({list:vi.fn(),save:vi.fn(),test:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({destroy:native.destroy,onCloseRequested:async(handler:typeof native.close)=>{native.close=handler;return()=>{};}})}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:vi.fn()}));
vi.mock('./api-profiles-api',()=>({apiProfiles:api}));
vi.mock('./application',()=>({application:{bootstrap:async()=>({defaultPath:'C:/fixture',library:null,restoreError:null})}}));
import App from './App';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement, root:ReturnType<typeof createRoot>;
beforeEach(async()=>{
  native.destroy.mockReset();api.list.mockReset();api.save.mockReset();api.test.mockReset();
  api.list.mockResolvedValue([]);native.destroy.mockResolvedValue(undefined);
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(<App/>));
  await click('AI 与 API');
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function click(text:string){const button=Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.includes(text));expect(button).toBeDefined();await act(async()=>button!.click());}
async function fill(){
  const inputs=host.querySelectorAll<HTMLInputElement>('.api-field input');
  for(const [index,value] of ['虚构接口','http://127.0.0.1:49537/v1/chat/completions','fixture-model','synthetic-only'].entries()){
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(inputs[index],value);inputs[index].dispatchEvent(new Event('input',{bubbles:true}));});
  }
}
it('native close protects an unsaved API draft and returning retains its fields',async()=>{
  await fill();await act(async()=>native.close({preventDefault:vi.fn()}));
  expect(native.destroy).not.toHaveBeenCalled();expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('API 配置还有未保存修改');
  await click('返回设置');expect(host.querySelector<HTMLInputElement>('.api-field input')?.value).toBe('虚构接口');
  expect(host.querySelector<HTMLInputElement>('input[name="api-key"]')?.value).toBe('synthetic-only');
});
it('native close waits for the actual connection result before allowing a clean window to close',async()=>{
  const profile={id:'fixture',name:'已保存接口',endpoint:'http://127.0.0.1:49537/v1/chat/completions',model:'fixture-model',isDefault:true,hasKey:true};
  // Save produces a clean draft, and testing the stored key does not dirty it.
  await fill();api.save.mockResolvedValue([{...profile,name:'虚构接口'}]);
  await click('保存配置');
  let finish!:(value:{message:string})=>void;api.test.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await click('测试连接');await act(async()=>native.close({preventDefault:vi.fn()}));
  expect(native.destroy).not.toHaveBeenCalled();expect(host.textContent).toContain('请等待完成后再关闭');
  await act(async()=>finish({message:'受控测试完成'}));
  await act(async()=>native.close({preventDefault:vi.fn()}));expect(native.destroy).toHaveBeenCalledOnce();
});
