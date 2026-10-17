export interface ApiProfile {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  isDefault: boolean;
  hasKey: boolean;
}
export interface ApiProfileDraft {
  id: string | null;
  name: string;
  endpoint: string;
  model: string;
  isDefault: boolean;
  /** null preserves the saved secret; never returned by list. */
  key: string | null;
}
export interface ApiConnectionReport { message: string }
export interface ApiProfilesPort {
  list(): Promise<ApiProfile[]>;
  save(draft: ApiProfileDraft): Promise<ApiProfile[]>;
  test(draft: ApiProfileDraft): Promise<ApiConnectionReport>;
}
export const emptyApiDraft = (): ApiProfileDraft => ({ id: null, name: '', endpoint: '', model: '', isDefault: false, key: '' });
export const editApiProfile = (profile: ApiProfile): ApiProfileDraft => ({ id: profile.id, name: profile.name, endpoint: profile.endpoint, model: profile.model, isDefault: profile.isDefault, key: null });

export interface ApiSettingsState {
  profiles: ApiProfile[];
  draft: ApiProfileDraft;
  ready: boolean;
  busy: 'loading' | 'saving' | 'testing' | null;
  dirty: boolean;
  error: string | null;
  status: string | null;
}
function safeError(error: unknown, key: string | null): string {
  let message = error instanceof Error ? error.message : String(error);
  if (key) message = message.split(key).join('[密钥已遮蔽]');
  return message.slice(0, 500) || '操作未完成，填写项已保留，请重试。';
}
/** Owns only API settings drafts. It has no port for reading books, chapters or attachments. */
export class ApiSettingsController {
  private listeners = new Set<() => void>();
  private baseline = emptyApiDraft();
  private state: ApiSettingsState = { profiles: [], draft: emptyApiDraft(), ready: false, busy: null, dirty: false, error: null, status: null };
  constructor(private readonly api: ApiProfilesPort) {}
  getSnapshot = (): ApiSettingsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<ApiSettingsState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private select(profile?: ApiProfile) {
    const draft = profile ? editApiProfile(profile) : emptyApiDraft();
    this.baseline = { ...draft };
    this.publish({ draft, dirty: false, error: null, status: null });
  }
  async load(): Promise<void> {
    if (this.state.busy || this.state.dirty) return;
    this.publish({ busy: 'loading', error: null });
    try {
      const profiles = await this.api.list();
      this.publish({ profiles, ready: true });
      this.select(profiles.find(profile => profile.isDefault) ?? profiles[0]);
    } catch (error) {
      this.publish({ error: safeError(error, null) });
    } finally { this.publish({ busy: null }); }
  }
  /** Returns false when the UI must ask before discarding an unsaved draft. */
  choose(id: string | null, discard = false): boolean {
    if (!this.state.ready || this.state.busy || this.state.dirty && !discard) return false;
    const profile = this.state.profiles.find(item => item.id === id);
    if (id !== null && !profile) return false;
    this.select(profile);
    return true;
  }
  update(update: Partial<Omit<ApiProfileDraft, 'id'>>): void {
    if (!this.state.ready || this.state.busy) return;
    const draft = { ...this.state.draft, ...update };
    // A changed destination must never inherit a previously entered or saved key.
    if (update.endpoint !== undefined && update.endpoint !== this.state.draft.endpoint && !('key' in update)) draft.key = '';
    this.publish({ draft, dirty: JSON.stringify(draft) !== JSON.stringify(this.baseline), error: null, status: null });
  }
  async save(): Promise<boolean> {
    if (!this.state.ready || this.state.busy) return false;
    const draft = { ...this.state.draft };
    this.publish({ busy: 'saving', error: null, status: null });
    try {
      const profiles = await this.api.save(draft);
      const saved = profiles.find(profile => draft.id ? profile.id === draft.id : profile.name === draft.name.trim());
      if (!saved) throw new Error('未能确认配置的保存结果，请重新打开设置核对。');
      this.publish({ profiles });
      // Fresh saved view contains no secret; clear the typed key only after confirmed persistence.
      this.select(saved);
      this.publish({ status: '配置已保存到本机。保存没有发送请求。' });
      return true;
    } catch (error) {
      this.publish({ error: safeError(error, draft.key) });
      return false;
    } finally {

      this.publish({ busy: null });
    }
  }
  async test(): Promise<void> {
    if (!this.state.ready || this.state.busy) return;
    const draft = { ...this.state.draft };
    this.publish({ busy: 'testing', error: null, status: null });
    try {
      const report = await this.api.test(draft);
      this.publish({ status: report.message });
    } catch (error) { this.publish({ error: safeError(error, draft.key) }); }
    finally { this.publish({ busy: null }); }
  }
}
