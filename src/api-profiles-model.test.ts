import { describe, expect, it, vi } from 'vitest';
import { ApiSettingsController, type ApiProfile, type ApiProfilesPort } from './api-profiles-model';
const first: ApiProfile = { id: 'one', name: '本地测试', endpoint: 'http://127.0.0.1:8000/v1/chat/completions', model: 'fixture-model', isDefault: false, hasKey: true };
const second: ApiProfile = { ...first, id: 'two', name: '备用接口', isDefault: true };
function setup() {
  const api: ApiProfilesPort = { list: vi.fn(async () => [first, second]), save: vi.fn(), test: vi.fn() };
  return { api, controller: new ApiSettingsController(api) };
}
describe('API settings draft lifecycle', () => {
  it('reopens the saved default with a blank secret and no network test', async () => {
    const { api, controller } = setup(); await controller.load();
    expect(controller.getSnapshot().draft).toEqual({ id: 'two', name: '备用接口', endpoint: second.endpoint, model: second.model, isDefault: true, key: null });
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(api.test).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
  });
  it('keeps every entered field and the masked key through save and test failures', async () => {
    const { api, controller } = setup(); await controller.load(); controller.choose(null);
    controller.update({ name: '新接口', endpoint: 'https://example.invalid/v1/chat/completions', model: 'model-x', key: 'fake-secret', isDefault: true });
    const before = { ...controller.getSnapshot().draft };
    vi.mocked(api.save).mockRejectedValue(new Error('存储失败 fake-secret'));
    expect(await controller.save()).toBe(false);
    expect(controller.getSnapshot().draft).toEqual(before);
    expect(controller.getSnapshot().error).not.toContain('fake-secret');
    vi.mocked(api.test).mockRejectedValue(new Error('HTTP 401'));
    await controller.test();
    expect(controller.getSnapshot().draft).toEqual(before); expect(controller.getSnapshot().dirty).toBe(true);
    expect(api.test).toHaveBeenCalledWith(before);
  });
  it('saves without testing, then clears the typed secret and reopens the saved view', async () => {
    const { api, controller } = setup(); await controller.load(); controller.choose(null);
    controller.update({ name: '第三套', endpoint: first.endpoint, model: first.model, key: 'fake-third', isDefault: true });
    const third = { ...first, id: 'three', name: '第三套', isDefault: true };
    vi.mocked(api.save).mockResolvedValue([first, { ...second, isDefault: false }, third]);
    expect(await controller.save()).toBe(true);
    expect(controller.getSnapshot().draft.key).toBeNull(); expect(controller.getSnapshot().draft.id).toBe('three');
    expect(controller.getSnapshot().dirty).toBe(false); expect(api.test).not.toHaveBeenCalled();
    const reopened = new ApiSettingsController({ ...api, list: async () => [first, { ...second, isDefault: false }, third] });
    await reopened.load(); expect(reopened.getSnapshot().draft.id).toBe('three');
  });
  it('does not silently discard changes or attribute old test results to edited inputs', async () => {
    const { api, controller } = setup(); await controller.load();
    vi.mocked(api.test).mockResolvedValue({ message: '测试成功' }); await controller.test();
    controller.update({ model: 'changed' });
    expect(controller.getSnapshot().status).toBeNull();
    expect(controller.choose('one')).toBe(false); expect(controller.getSnapshot().draft.model).toBe('changed');
    expect(controller.choose('one', true)).toBe(true); expect(controller.getSnapshot().draft.id).toBe('one');
  });
  it('prevents concurrent test/save and profile switches while a request is pending', async () => {
    const { api, controller } = setup(); await controller.load();
    let complete!: (value: { message: string }) => void;
    vi.mocked(api.test).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = controller.test();
    expect(controller.getSnapshot().busy).toBe('testing');
    controller.update({ name: 'must not apply' }); expect(controller.choose('one', true)).toBe(false);
    await controller.save(); await controller.test();
    expect(api.test).toHaveBeenCalledTimes(1); expect(api.save).not.toHaveBeenCalled();
    complete({ message: '成功' }); await pending;
    expect(controller.getSnapshot().busy).toBeNull(); expect(controller.getSnapshot().draft.name).toBe('备用接口');
  });
  it('can retry initialization without inventing a successful empty state', async () => {
    const { api, controller } = setup(); vi.mocked(api.list).mockRejectedValueOnce(new Error('不可读'));
    await controller.load(); expect(controller.getSnapshot().ready).toBe(false);
    controller.update({ name: 'must not apply' }); expect(controller.getSnapshot().draft.name).toBe('');
    await controller.load(); expect(controller.getSnapshot().ready).toBe(true); expect(controller.getSnapshot().error).toBeNull();
  });
});
