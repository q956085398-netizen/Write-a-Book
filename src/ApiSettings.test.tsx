// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSettings, type ApiSettingsActivity } from './ApiSettings';
import type { ApiProfile, ApiProfilesPort } from './api-profiles-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const first: ApiProfile = { id: 'one', name: '主要接口', endpoint: 'https://first.invalid/v1/chat/completions', model: 'fixture-one', isDefault: true, hasKey: true };
const second: ApiProfile = { ...first, id: 'two', name: '备用接口', endpoint: 'https://second.invalid/v1/chat/completions', model: 'fixture-two', isDefault: false };
let root: Root;
let container: HTMLDivElement;
let api: ApiProfilesPort;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  api = { list: vi.fn(async () => [first, second]), save: vi.fn(), test: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function mount(props: { onClose?: () => void; onStateChange?: (state: ApiSettingsActivity) => void } = {}) {
  await act(async () => { root.render(<ApiSettings api={api} {...props} />); });
}
function input(label: string): HTMLInputElement {
  const node = Array.from(container.querySelectorAll('label')).find(item => item.textContent === label)!;
  return container.querySelector<HTMLInputElement>(`[id="${node.htmlFor}"]`)!;
}
function button(text: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(text))!;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function fill(label: string, value: string) {
  await act(async () => {
    const node = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function fillNew() {
  await fill('名称', '新配置');
  await fill('完整 Chat Completions 地址', 'https://new.invalid/v1/chat/completions');
  await fill('模型', 'fixture-new');
  await fill('API 密钥', 'fake-component-key');
}

describe('API settings interactions', () => {
  it('opens only the saved default with no implicit service call or secret readback', async () => {
    await mount();
    expect(input('名称').value).toBe(first.name);
    expect(input('API 密钥').type).toBe('password');
    expect(input('API 密钥').value).toBe('');
    expect(input('API 密钥').required).toBe(false);
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(api.list).toHaveBeenCalledTimes(1); expect(api.test).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
    expect(container.textContent).toContain('不会自动拼接路径');
    expect(container.textContent).toContain('Reply with OK.');
    expect(container.textContent).toContain('请求可能计费');
  });
  it('starts with a real empty list and creates the first profile without testing', async () => {
    vi.mocked(api.list).mockResolvedValue([]);
    const saved = { ...first, id: 'new', name: '新配置', model: 'fixture-new', endpoint: 'https://new.invalid/v1/chat/completions' };
    vi.mocked(api.save).mockResolvedValue([saved]);
    const activity = vi.fn(); await mount({ onStateChange: activity });
    expect(container.textContent).toContain('尚无已保存的配置');
    expect(input('名称').value).toBe(''); expect(input('API 密钥').required).toBe(true);
    await fillNew(); expect(input('API 密钥').type).toBe('password');
    await click('显示'); expect(input('API 密钥').type).toBe('text');
    await submit();
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ name: '新配置', key: 'fake-component-key' }));
    expect(api.test).not.toHaveBeenCalled(); expect(input('API 密钥').value).toBe(''); expect(input('API 密钥').type).toBe('password');
    expect(container.textContent).toContain('保存没有发送请求');
    expect(activity).toHaveBeenLastCalledWith({ dirty: false, busy: null });
  });
  it('keeps typed fields and a masked secret after failures and tests unsaved inputs separately', async () => {
    vi.mocked(api.save).mockRejectedValue(new Error('磁盘不可写 fake-component-key'));
    vi.mocked(api.test).mockRejectedValue(new Error('HTTP 401'));
    await mount(); await click('添加配置'); await fillNew(); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('磁盘不可写');
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('fake-component-key');
    expect(input('API 密钥').value).toBe('fake-component-key'); expect(input('API 密钥').type).toBe('password');
    await click('测试连接');
    expect(api.test).toHaveBeenCalledWith(expect.objectContaining({ id: null, name: '新配置', key: 'fake-component-key', model: 'fixture-new' }));
    expect(api.save).toHaveBeenCalledTimes(1); expect(container.querySelector('[role="alert"]')?.textContent).toContain('HTTP 401');
    expect(input('名称').value).toBe('新配置'); expect(input('API 密钥').value).toBe('fake-component-key');
    vi.mocked(api.test).mockResolvedValue({ message: '固定短测试已成功。' }); await click('测试连接');
    expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.querySelector('[role="status"]')?.textContent).toContain('固定短测试已成功');
    expect(input('API 密钥').value).toBe('fake-component-key');
    await fill('模型', 'another-model'); expect(container.querySelector('[role="status"]')).toBeNull();
  });
  it('requires a fresh secret when editing an endpoint, including after typing a replacement', async () => {
    await mount(); await fill('完整 Chat Completions 地址', 'https://new.invalid/v1/chat/completions');
    expect(input('API 密钥').value).toBe(''); expect(input('API 密钥').required).toBe(true);
    await click('测试连接'); expect(api.test).not.toHaveBeenCalled();
    await fill('API 密钥', 'fake-replacement');
    await fill('完整 Chat Completions 地址', 'https://other.invalid/v1/chat/completions');
    expect(input('API 密钥').value).toBe('');
  });
  it('guards dirty profile switches and closing, with a way to keep or explicitly discard the draft', async () => {
    const close = vi.fn(); await mount({ onClose: close });
    await fill('名称', '尚未保存'); await click('备用接口');
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull(); expect(input('名称').value).toBe('尚未保存');
    await click('继续编辑'); expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    await click('返回写作'); expect(close).not.toHaveBeenCalled(); await click('继续编辑');
    await click('备用接口'); await click('放弃修改并切换'); expect(input('名称').value).toBe(second.name);
    expect(input('API 密钥').type).toBe('password');
    await fill('模型', 'unsaved-model'); await click('返回写作'); await click('放弃修改并返回'); expect(close).toHaveBeenCalledTimes(1);
  });
  it('only changes the default after explicit save', async () => {
    await mount(); await click('备用接口');
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true); expect(api.save).not.toHaveBeenCalled(); expect(api.test).not.toHaveBeenCalled();
    expect(container.querySelector('.api-profile-selected .api-profile-badge')).toBeNull();
    vi.mocked(api.save).mockResolvedValue([{ ...first, isDefault: false }, { ...second, isDefault: true }]); await submit();
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'two', isDefault: true, key: null }));
    expect(container.querySelector('.api-profile-selected .api-profile-badge')?.textContent).toBe('默认');
  });
  it('locks all edits, switching and closing during a request, then renders only its actual result', async () => {
    let resolve!: (value: { message: string }) => void;
    vi.mocked(api.test).mockImplementation(() => new Promise(done => { resolve = done; }));
    const activity = vi.fn(); const close = vi.fn(); await mount({ onStateChange: activity, onClose: close });
    await click('测试连接');
    expect(activity).toHaveBeenLastCalledWith({ dirty: false, busy: 'testing' });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('正在测试连接');
    expect(input('名称').matches(':disabled')).toBe(true); expect(button('返回写作').disabled).toBe(true); expect(button('添加配置').disabled).toBe(true);
    await click('备用接口'); await submit(); await click('返回写作');
    expect(api.save).not.toHaveBeenCalled(); expect(api.test).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
    await act(async () => { resolve({ message: '仅此次短测试成功。' }); });
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.textContent).not.toContain('正在测试连接'); expect(container.querySelector('[role="status"]')?.textContent).toContain('仅此次短测试成功');
    expect(activity).toHaveBeenLastCalledWith({ dirty: false, busy: null });
  });
  it('can retry a loading failure and return to writing without configuring API', async () => {
    vi.mocked(api.list).mockRejectedValueOnce(new Error('本机配置目录不可读'));
    const close = vi.fn(); await mount({ onClose: close });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('本机配置目录不可读');
    expect(input('名称').matches(':disabled')).toBe(true);
    await click('返回写作'); expect(close).toHaveBeenCalledTimes(1);
    await click('重试读取配置'); expect(input('名称').value).toBe(first.name); expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
