import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiProfiles } from './api-profiles-api';
import { ApiSettingsController, type ApiProfilesPort, type ApiSettingsState } from './api-profiles-model';
import './api-settings.css';

export interface ApiSettingsActivity {
  dirty: boolean;
  busy: ApiSettingsState['busy'];
}
export interface ApiSettingsProps {
  api?: ApiProfilesPort;
  onClose?: () => void;
  /** The host must consult this state before unmounting or closing the native window. */
  onStateChange?: (activity: ApiSettingsActivity) => void;
}
type LeaveAction = { kind: 'choose'; id: string | null } | { kind: 'close' };

export function ApiSettings({ api = apiProfiles, onClose, onStateChange }: ApiSettingsProps) {
  const controller = useMemo(() => new ApiSettingsController(api), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { draft, profiles, ready, busy, dirty, error, status } = state;
  const [showKey, setShowKey] = useState(false);
  const [leave, setLeave] = useState<LeaveAction | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const activityCallback = useRef(onStateChange);
  activityCallback.current = onStateChange;
  const id = useId();
  const selected = profiles.find(profile => profile.id === draft.id);
  const locked = !ready || !!busy || !!leave;
  const keyRequired = draft.key !== null || !selected?.hasKey || draft.endpoint !== selected.endpoint;

  useEffect(() => { void controller.load(); }, [controller]);
  useEffect(() => { activityCallback.current?.({ dirty, busy }); }, [dirty, busy]);
  useEffect(() => { if (draft.key === null) setShowKey(false); }, [draft.key]);
  useEffect(() => {
    if (leave) prompt.current?.focus();
    else returnFocus.current?.focus();
  }, [leave]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirty && !busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, busy]);

  function perform(action: LeaveAction, discard = false) {
    if (busy) return;
    if (dirty && !discard) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLeave(action);
      return;
    }
    setShowKey(false);
    if (action.kind === 'choose') controller.choose(action.id, discard);
    else onClose?.();
  }
  function cancelLeave() {
    setLeave(null);
  }
  async function testConnection() {
    if (form.current?.reportValidity()) await controller.test();
  }

  return <section className="api-settings" aria-labelledby={`${id}-title`}>
    <header className="api-settings-heading">
      <div><p className="api-settings-eyebrow">设置 / 全应用</p><h1 id={`${id}-title`}>AI 与 API</h1></div>
      {onClose && <button type="button" disabled={!!busy || !!leave} onClick={() => perform({ kind: 'close' })}>返回写作</button>}
    </header>
    <p className="api-settings-intro">管理自己的接口与模型。核心记录与写作可离线使用，无需先配置 API。</p>
    {leave && <div ref={prompt} tabIndex={-1} className="api-leave-prompt" role="alertdialog" aria-labelledby={`${id}-leave-title`} aria-describedby={`${id}-leave-body`} onKeyDown={event => { if (event.key === 'Escape') cancelLeave(); }}>
      <h2 id={`${id}-leave-title`}>保留当前填写，还是放弃修改？</h2>
      <p id={`${id}-leave-body`}>当前配置尚未保存。放弃后，未保存的字段与新填写的密钥将被清除。</p>
      <div className="api-prompt-actions">
        <button type="button" onClick={cancelLeave}>继续编辑</button>
        <button type="button" onClick={() => { const action = leave; setLeave(null); perform(action, true); }}>放弃修改并{leave.kind === 'close' ? '返回' : '切换'}</button>
      </div>
    </div>}
    <div className="api-settings-columns">
      <div className="api-settings-editor">
        <div className="api-editor-heading"><h2>{selected ? selected.name : '新增配置'}</h2><span>{dirty ? '未保存修改' : selected ? '已保存到本机' : '填写后保存'}</span></div>
        <form ref={form} onSubmit={event => { event.preventDefault(); void controller.save(); }}>
          <fieldset disabled={locked}>
            <div className="api-field"><label htmlFor={`${id}-name`}>名称</label><input id={`${id}-name`} value={draft.name} onChange={event => controller.update({ name: event.target.value })} required maxLength={120} autoComplete="off" /><p>为这套配置取一个容易识别的名称。</p></div>
            <div className="api-field"><label htmlFor={`${id}-endpoint`}>完整 Chat Completions 地址</label><input id={`${id}-endpoint`} type="url" value={draft.endpoint} onChange={event => { setShowKey(false); controller.update({ endpoint: event.target.value }); }} required autoComplete="off" spellCheck={false} placeholder="https://服务地址/v1/chat/completions" aria-describedby={`${id}-endpoint-help`} /><p id={`${id}-endpoint-help`}>填写完整 POST 地址，不会自动拼接路径。使用 HTTPS；本机测试可用 HTTP。更改地址后须重新填写密钥。</p></div>
            <div className="api-field"><label htmlFor={`${id}-model`}>模型</label><input id={`${id}-model`} value={draft.model} onChange={event => controller.update({ model: event.target.value })} required maxLength={200} autoComplete="off" spellCheck={false} /><p>填写服务支持的模型名称，不会自动查询。</p></div>
            <div className="api-field"><label htmlFor={`${id}-key`}>API 密钥</label><div className="api-key-input"><input id={`${id}-key`} name="api-key" type={showKey ? 'text' : 'password'} value={draft.key ?? ''} onChange={event => controller.update({ key: event.target.value })} required={keyRequired} maxLength={4096} autoComplete="off" spellCheck={false} placeholder={draft.key === null && selected?.hasKey ? '已保存密钥，留空沿用' : '输入密钥'} aria-describedby={`${id}-key-help`} /><button type="button" aria-label={showKey ? '遮蔽密钥' : '显示密钥'} aria-pressed={showKey} disabled={!draft.key} onClick={() => setShowKey(value => !value)}>{showKey ? '遮蔽' : '显示'}</button></div><p id={`${id}-key-help`}>{draft.key === null && selected?.hasKey ? '密钥已加密保存在本机，不会回显。可填写新密钥替换。' : '密钥默认遮蔽，保存后会清空输入框并加密保存在本机。'}</p></div>
            <label className="api-default-option"><input type="checkbox" checked={draft.isDefault || profiles.length === 0} disabled={selected?.isDefault || profiles.length === 0} onChange={event => controller.update({ isDefault: event.target.checked })} />{selected?.isDefault ? '当前默认配置' : profiles.length === 0 ? '第一套配置将自动设为默认' : '保存后设为默认配置'}</label>
            <div className="api-settings-actions"><button type="submit">{busy === 'saving' ? '正在保存…' : '保存配置'}<small>不会发送请求</small></button><button type="button" className="api-test-button" onClick={() => void testConnection()}>{busy === 'testing' ? '测试中…' : '测试连接'}</button></div>
          </fieldset>
        </form>
        <p className="api-test-notice">仅主动测试时发送固定短句 <code>Reply with OK.</code>，不发送作品、章节或附件。请求可能计费；测试不会保存填写项。</p>
        <div className="api-settings-feedback" aria-live="polite" aria-atomic="true">
          {busy && <div className="api-feedback api-feedback-progress" role="status"><span className="api-feedback-mark" aria-hidden="true">◌</span><div><strong>{busy === 'loading' ? '正在读取本机配置…' : busy === 'saving' ? '正在保存到本机…' : '正在测试连接…'}</strong><p>{busy === 'testing' ? '已主动发起固定短句测试，请稍候。' : '请等待操作完成。'}</p></div></div>}
          {!busy && error && <div className="api-feedback api-feedback-error" role="alert"><span className="api-feedback-mark" aria-hidden="true">!</span><div><strong>{ready ? '操作未完成' : '配置读取失败'}</strong><p>{error}</p>{!ready && <button type="button" onClick={() => void controller.load()}>重试读取配置</button>}</div></div>}
          {!busy && !error && status && <div className="api-feedback api-feedback-success" role="status"><span className="api-feedback-mark" aria-hidden="true">✓</span><div><strong>操作完成</strong><p>{status}</p></div></div>}
        </div>
      </div>
      <aside className="api-profile-list" aria-labelledby={`${id}-list-title`}>
        <div className="api-profile-list-heading"><h2 id={`${id}-list-title`}>配置列表</h2><button type="button" disabled={locked} onClick={() => perform({ kind: 'choose', id: null })}><span aria-hidden="true">＋ </span>添加配置</button></div>
        {ready && profiles.length === 0 && <p className="api-profile-empty">尚无已保存的配置。填写左侧表单即可添加第一套。</p>}
        <ul>{profiles.map(profile => <li key={profile.id}><button type="button" className={`api-profile${profile.id === draft.id ? ' api-profile-selected' : ''}`} disabled={locked || profile.id === draft.id} aria-current={profile.id === draft.id ? 'true' : undefined} onClick={() => perform({ kind: 'choose', id: profile.id })}><span className="api-profile-title"><span className="api-profile-dot" aria-hidden="true" /><strong>{profile.name}</strong>{profile.isDefault && <span className="api-profile-badge">默认</span>}</span><span className="api-profile-address">{profile.endpoint}</span><span className="api-profile-model">{profile.model}</span></button></li>)}</ul>
        <p className="api-profile-scope">配置为全应用共用。默认配置的更改将在保存后生效。默认备份不包含 API 密钥，换机须重新填写。</p>
      </aside>
    </div>
  </section>;
}
