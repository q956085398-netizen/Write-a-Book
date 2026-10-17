import { useState, useSyncExternalStore } from 'react';
import type { ConceptionController, ConceptionSnapshot } from './controller';
import type { ConceptionSection } from './types';
import { ConceptionEditor } from './Editor';
import { ConceptionPreview } from './Preview';
import './conception.css';
const saveLabels = {saved:'已保存到本地',unsaved:'尚未保存',saving:'正在保存…',error:'保存未完成'};

export interface ConceptionWorkspaceProps { controller: ConceptionController; disabled?: boolean; onReturn: () => void }
export function ConceptionWorkspace({controller,disabled=false,onReturn}: ConceptionWorkspaceProps) {
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
  const view=state.view;
  const blocked=disabled || state.busy;
  const [referenceSection,setReferenceSection]=useState('');
  if (!view) return null;
  const record=state.editor.chapter;
  const section=view.sections.find(section => section.id===state.selectedSection);
  const referenced=new Set(view.references.filter(reference => reference.recordId===record?.id).map(reference => reference.sectionId));
  return <section className="conception-workspace" aria-label={`${view.workTitle}的构思`} onMouseDownCapture={event => {if (controller.isComposing() && event.target instanceof Element && event.target.closest('button')) event.preventDefault();}}>
    <header className="conception-heading"><div><span className="conception-eyebrow">本书构思</span><h1>{view.workTitle}</h1></div><div className="conception-actions"><button disabled={blocked} onClick={() => void controller.openSettings()}>分区管理</button><button disabled={blocked} onClick={() => void controller.showRecovery()}>构思恢复记录{state.candidates.length ? ` · ${state.candidates.length}` : ''}</button><button disabled={blocked} onClick={onReturn}>返回正文</button></div></header>
    {(state.error || state.editor.error) && <div className="conception-error" role="alert"><span>{state.editor.error || state.error}</span><button disabled={blocked} onClick={() => void controller.flush()}>重试保存</button></div>}
    {!state.recoveryOpen && state.candidates.length>0 && <div className="conception-recovery-notice" role="status"><span>发现 {state.candidates.length} 份本书构思草稿，请核对后选择；不会自动覆盖原记录。</span><button disabled={blocked} onClick={() => void controller.showRecovery()}>查看待恢复构思</button></div>}
    {state.settingsOpen ? <Settings controller={controller} state={state} disabled={blocked}/> : state.recoveryOpen ? <section className="conception-recovery" aria-label="构思恢复记录">
      <div className="conception-section-heading"><h2>核对本书构思草稿</h2><button disabled={blocked} onClick={() => controller.closeRecovery()}>返回构思</button><button disabled={blocked} onClick={() => void controller.showRecovery()}>刷新</button></div>
      {!state.candidates.length && <p>没有待核对的构思草稿。</p>}
      {record && <section><h3>当前窗口内容 · {record.title || '未命名构思'}</h3><ConceptionPreview key={`memory-${record.contentId}-${record.revision}`} content={record} label="当前窗口构思全文" port={controller.port}/></section>}
      {state.candidates.map(candidate => <article key={`${candidate.id}-${candidate.sequence}`} className="conception-recovery-record"><h3>{candidate.draft.title || '未命名构思'}</h3><p>{candidate.integrityError ? `完整性未确认：${candidate.integrityError}` : candidate.conflict ? '版本先后不明。原记录保留，可另存构思副本。' : '可继续此版本，或保留原记录并另存副本。'}</p>
        {candidate.current && <><h4>资料库当前版本</h4><ConceptionPreview key={`current-${candidate.current.contentId}-${candidate.current.revision}`} content={candidate.current} label="资料库当前构思全文" port={controller.port}/></>}
        <h4>恢复草稿</h4><ConceptionPreview content={candidate.draft} label="构思恢复草稿全文" port={controller.port}/>
        <div className="conception-actions">{!candidate.conflict && <button disabled={blocked || !!candidate.integrityError} onClick={() => void controller.recover(candidate,false)}>继续此版本</button>}<button disabled={blocked || !!candidate.integrityError} onClick={() => void controller.recover(candidate,true)}>另存构思副本</button></div>
      </article>)}
    </section> : <div className="conception-layout">
      <nav className="conception-directory" aria-label="本书构思分区">{view.sections.filter(section => !section.hidden).map(section => <div key={section.id}><button className={section.id===state.selectedSection ? 'selected' : ''} disabled={blocked} onClick={() => void controller.openSection(section.id)}>{section.name}</button>
        {view.references.filter(reference => reference.sectionId===section.id).map(reference => <button className={`conception-record-link ${record?.id===reference.recordId ? 'selected' : ''}`} key={reference.id} disabled={blocked} onClick={() => void controller.openRecord(reference.recordId,section.id)}>{view.records.find(record => record.id===reference.recordId)?.title || '未命名构思'}</button>)}
      </div>)}{!view.sections.some(section => !section.hidden) && <p>分区已隐藏或尚未添加。可从分区管理打开内容或恢复入口。</p>}</nav>
      <div className="conception-main"><div className="conception-section-heading"><h2>{section?.name || '自由构思'}{section?.hidden && <span className="conception-hidden">已隐藏 · 直接打开</span>}</h2><button disabled={blocked || !section} onClick={() => void controller.create()}>新建构思</button></div>
        {section?.hidden && <div className="conception-hidden-list" aria-label="隐藏分区内容">{view.references.filter(reference => reference.sectionId===section.id).map(reference => <button disabled={blocked} key={reference.id} onClick={() => void controller.openRecord(reference.recordId,section.id)}>{view.records.find(record => record.id===reference.recordId)?.title || '未命名构思'}</button>)}</div>}
        {record ? <><div className="conception-save"><span role="status">{saveLabels[state.editor.status]}</span><button disabled={blocked} onClick={() => void controller.flush()}>保存</button></div>
          <label className="sr-only" htmlFor="conception-title">构思标题</label><input id="conception-title" className="conception-title" value={record.title} placeholder="未命名构思" disabled={blocked} onChange={event => controller.session.edit('title',event.target.value)} onCompositionStart={() => controller.session.beginComposition()} onCompositionEnd={() => controller.session.endComposition()}/>
          <details className="conception-prompts"><summary>可选提示</summary><p>可以从一句话、一个结局、一种感受、人物间的关系，或尚未解决的冲突开始。也可以直接写自己的想法。</p></details>
          <div className="conception-editor"><ConceptionEditor key={record.contentId} port={controller.port} chapter={record} session={controller.session} disabled={blocked} label="构思内容"/></div>
          <div className="conception-reference"><span>同一记录出现在：{view.sections.filter(section => referenced.has(section.id)).map(section => `${section.name}${section.hidden ? '（已隐藏）' : ''}`).join('、')}</span>
            <form onSubmit={event => {event.preventDefault();if (referenceSection) void controller.reference(referenceSection).then(success => {if (success) setReferenceSection('');});}}><label>引用到分区<select aria-label="引用目标分区" disabled={blocked} value={referenceSection} onChange={event => setReferenceSection(event.target.value)}><option value="">选择分区</option>{view.sections.filter(section => !referenced.has(section.id)).map(section => <option key={section.id} value={section.id}>{section.name}{section.hidden ? '（已隐藏）' : ''}</option>)}</select></label><button disabled={blocked || !referenceSection}>引用同一记录</button></form>
          </div>
        </> : <p className="conception-empty">{section ? '点“新建构思”，直接写下此刻的想法。' : '可以从分区管理中添加分区，随时回到正文写作。'}</p>}
      </div>
    </div>}
  </section>;
}
function Settings({controller,state,disabled}: {controller:ConceptionController; state:ConceptionSnapshot; disabled:boolean}) {
  const view=state.view!;
  const composition={onCompositionStart:() => controller.session.beginComposition(),onCompositionEnd:() => controller.session.endComposition()};
  return <section className="conception-settings" aria-label="构思分区管理"><div className="conception-section-heading"><h2>分区管理</h2><button disabled={disabled} onClick={() => void controller.closeSettings()}>返回构思</button></div>
    <section><h3>当前作品 · {view.workTitle}</h3><p>只影响本书。隐藏保留记录与功能；打开隐藏内容不会自动恢复目录入口。</p><SectionRows sections={state.sectionsDraft} onChange={sections => controller.editSections(sections)} disabled={disabled} composition={composition} canRemove={id => !view.references.some(reference => reference.sectionId===id)} onOpen={id => void controller.openSection(id)} persistedIds={new Set(view.sections.map(section => section.id))}/></section>
    <section><h3>新作品默认分区</h3><p>仅用于当前资料库中以后创建的新作品，已有作品保持原配置。名称和组合都可以调整。</p><SectionRows sections={state.defaultsDraft} onChange={sections => controller.editDefaults(sections)} disabled={disabled} composition={composition}/></section>
    <div className="conception-actions"><button disabled={disabled || (!state.sectionsDirty && !state.defaultsDirty)} onClick={() => void controller.saveSettings()}>保存分区设置</button><button disabled={disabled || (!state.sectionsDirty && !state.defaultsDirty)} onClick={() => controller.discardSettings()}>撤回未保存修改</button><span role="status">{state.sectionsDirty || state.defaultsDirty ? '分区设置尚未保存' : '分区设置已保存到本地'}</span></div>
  </section>;
}
function SectionRows({sections,onChange,disabled,composition,canRemove=() => true,onOpen,persistedIds}: {sections:ConceptionSection[];onChange:(sections:ConceptionSection[]) => void;disabled:boolean;composition:{onCompositionStart:() => void;onCompositionEnd:() => void};canRemove?:(id:string) => boolean;onOpen?:(id:string) => void;persistedIds?:Set<string>}) {
  const update=(index:number,patch:Partial<ConceptionSection>) => onChange(sections.map((section,i) => i===index ? {...section,...patch} : section));
  const move=(index:number,delta:number) => {const next=[...sections];[next[index],next[index+delta]]=[next[index+delta],next[index]];onChange(next);};
  return <><ol className="conception-section-rows">{sections.map((section,index) => <li key={section.id}><input aria-label={`分区名称 ${index+1}`} value={section.name} maxLength={100} disabled={disabled} {...composition} onChange={event => update(index,{name:event.target.value})}/><label><input type="checkbox" checked={!section.hidden} disabled={disabled} onChange={event => update(index,{hidden:!event.target.checked})}/>显示</label><button aria-label={`上移 ${section.name}`} title="上移" disabled={disabled || index===0} onClick={() => move(index,-1)}>↑</button><button aria-label={`下移 ${section.name}`} title="下移" disabled={disabled || index===sections.length-1} onClick={() => move(index,1)}>↓</button>{onOpen && persistedIds?.has(section.id) && <button disabled={disabled} onClick={() => onOpen(section.id)}>打开内容</button>}<button disabled={disabled || !canRemove(section.id)} title={canRemove(section.id) ? '移除空分区' : '分区中有记录，请使用隐藏保留内容'} onClick={() => onChange(sections.filter(item => item.id!==section.id))}>移除</button></li>)}</ol><button disabled={disabled} onClick={() => onChange([...sections,{id:crypto.randomUUID(),name:'新分区',hidden:false}])}>添加分区</button></>;
}
