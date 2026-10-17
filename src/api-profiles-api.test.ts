import { describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => native);
import { apiProfiles } from './api-profiles-api';
import { editApiProfile, emptyApiDraft } from './api-profiles-model';

describe('API profile boundary', () => {
  it('starts with no implicit endpoint, model or saved secret', () => {
    expect(emptyApiDraft()).toEqual({ id: null, name: '', endpoint: '', model: '', isDefault: false, key: '' });
    expect(editApiProfile({ id: 'p', name: '测试', endpoint: 'https://example.com/v1/chat/completions', model: 'fixture', isDefault: true, hasKey: true }).key).toBeNull();
  });
  it('keeps save and explicit connection test as separate commands', async () => {
    native.invoke.mockResolvedValue([]);
    const draft = { ...emptyApiDraft(), name: '测试', key: 'fake-test-only' };
    await apiProfiles.list();
    await apiProfiles.save(draft);
    expect(native.invoke.mock.calls).toEqual([['api_list_profiles'], ['api_save_profile', { draft }]]);
    await apiProfiles.test(draft);
    expect(native.invoke).toHaveBeenLastCalledWith('api_test_connection', { draft });
  });
});
