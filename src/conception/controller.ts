import { EditorSession, type EditorSnapshot } from '../editor-session';
import { errorText } from '../model';
import type { ConceptionDefaults, ConceptionPort, ConceptionRecord, ConceptionRecoveryCandidate, ConceptionSection, ConceptionView } from './types';

export interface ConceptionSnapshot {
  view: ConceptionView | null;
  editor: EditorSnapshot;
  busy: boolean;
  error: string | null;
  selectedSection: string | null;
  settingsOpen: boolean;
  sectionsDraft: ConceptionSection[];
  defaults: ConceptionDefaults | null;
  defaultsDraft: ConceptionSection[];
  sectionsDirty: boolean;
  defaultsDirty: boolean;
  recoveryOpen: boolean;
  candidates: ConceptionRecoveryCandidate[];
}
const clone = (sections: ConceptionSection[]) => sections.map(section => ({ ...section }));
const compositionNotice = '请先完成中文输入，再离开构思。当前内容仍保留。';

// The App owns this controller for the entire library session. It must await flush before
// leaving the surface or destroying the window; React unmount is never a persistence trigger.
export class ConceptionController {
  readonly session: EditorSession;
  private state: ConceptionSnapshot;
  private listeners = new Set<() => void>();
  private operation: Promise<boolean> | null = null;
  private unsubscribe: () => void;
  constructor(readonly port: ConceptionPort) {
    this.session = new EditorSession({
      saveChapter: draft => port.save(draft),
      checkpointChapter: snapshot => port.checkpoint({ ...snapshot, base: { ...snapshot.base, bodyFormat: snapshot.base.bodyFormat ?? 'plain-text' } }),
      acknowledgeRecovery: (sessionId, contentId, sequence) => port.acknowledge(sessionId, contentId, sequence),
    });
    this.state = { view:null, editor:this.session.getSnapshot(), busy:false, error:null, selectedSection:null, settingsOpen:false,
      sectionsDraft:[], defaults:null, defaultsDraft:[], sectionsDirty:false, defaultsDirty:false, recoveryOpen:false, candidates:[] };
    this.unsubscribe = this.session.subscribe(() => {
      const editor = this.session.getSnapshot();
      const current = editor.chapter;
      const view = this.state.view;
      this.publish({ editor, ...(view && current ? { view:{...view,records:view.records.map(record => record.id === current.id ? {...record,...current,bodyFormat:current.bodyFormat ?? 'plain-text'} : record)} } : {}) });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  isComposing = () => this.session.isComposing();
  private publish(patch: Partial<ConceptionSnapshot>) { this.state = {...this.state,...patch}; this.listeners.forEach(listener => listener()); }
  private async settle() {
    if (this.isComposing()) throw new Error(compositionNotice);
    if (!(await this.session.flush())) throw new Error(this.session.getSnapshot().error ?? compositionNotice);
    if (this.state.sectionsDirty && this.state.view) {
      const view = await this.port.changeSections(this.state.view.workId,this.state.view.revision,this.state.sectionsDraft);
      this.publish({view,sectionsDraft:clone(view.sections),sectionsDirty:false});
    }
    if (this.state.defaultsDirty && this.state.defaults) {
      const defaults = await this.port.changeDefaults(this.state.defaults.revision,this.state.defaultsDraft);
      this.publish({defaults,defaultsDraft:clone(defaults.sections),defaultsDirty:false});
    }
  }
  private run(operation: () => Promise<void>, settle = true): Promise<boolean> {
    if (this.operation) return Promise.resolve(false);
    if (this.isComposing()) { this.publish({error:compositionNotice}); return Promise.resolve(false); }
    this.publish({busy:true,error:null});
    // Set the guard before entering async persistence, including synchronously throwing ports.
    const job = Promise.resolve().then(async () => {
      try { if (settle) await this.settle(); await operation(); return true; }
      catch (error) { this.publish({error:errorText(error)}); return false; }
      finally { this.operation=null; this.publish({busy:false}); }
    });
    this.operation=job;
    return job;
  }
  async flush(): Promise<boolean> {
    if (this.operation && !(await this.operation)) return false;
    return this.run(async () => {});
  }
  async preserveForRecovery(): Promise<boolean> {
    if (this.operation && !(await this.operation)) return false;
    if (this.isComposing()) { this.publish({error:compositionNotice}); return false; }
    return this.session.preserveForRecovery();
  }
  openWork(workId: string) {
    return this.run(async () => {
      const view = await this.port.view(workId);
      this.session.load(null);
      this.publish({view,selectedSection:view.sections.find(section => !section.hidden)?.id ?? null,settingsOpen:false,recoveryOpen:false,
        sectionsDraft:clone(view.sections),sectionsDirty:false,defaultsDirty:false,candidates:[]});
      try { this.publish({candidates:await this.port.listRecovery(workId)}); }
      catch (error) { this.publish({error:`构思恢复记录读取失败：${errorText(error)}`}); }
    });
  }
  openSection(sectionId: string) {
    return this.run(async () => {
      if (!this.state.view?.sections.some(section => section.id === sectionId)) throw new Error('此分区不属于当前作品。');
      this.session.load(null);
      this.publish({selectedSection:sectionId,settingsOpen:false,recoveryOpen:false});
    });
  }
  openRecord(id: string, sectionId?: string) {
    return this.run(async () => {
      const view = await this.port.view(this.state.view!.workId);
      const record = view.records.find(record => record.id === id);
      if (!record) throw new Error('本书中找不到此构思记录。');
      const target = sectionId ?? view.references.find(reference => reference.recordId === id)?.sectionId ?? null;
      if (target && !view.references.some(reference => reference.recordId === id && reference.sectionId === target)) throw new Error('此记录不在所选分区中。');
      this.session.load(record);
      this.publish({view,selectedSection:target,settingsOpen:false,recoveryOpen:false});
    });
  }
  create() {
    return this.run(async () => {
      const {view,selectedSection} = this.state;
      if (!view || !selectedSection) throw new Error('先在分区管理中添加或选择一个分区。');
      const record = await this.port.create(view.workId,selectedSection);
      const next = await this.port.view(view.workId);
      this.session.load(record);
      this.publish({view:next,settingsOpen:false,recoveryOpen:false});
    });
  }
  reference(sectionId: string) {
    return this.run(async () => {
      const {view,editor} = this.state;
      if (!view || !editor.chapter) throw new Error('请先打开一条构思。');
      this.publish({view:await this.port.reference(view.workId,editor.chapter.id,sectionId)});
    });
  }
  openSettings() {
    return this.run(async () => {
      const defaults = await this.port.defaults();
      this.publish({settingsOpen:true,recoveryOpen:false,defaults,defaultsDraft:clone(defaults.sections),sectionsDraft:clone(this.state.view!.sections),sectionsDirty:false,defaultsDirty:false});
    });
  }
  editSections(sections: ConceptionSection[]) { if (!this.state.busy) this.publish({sectionsDraft:clone(sections),sectionsDirty:true}); }
  editDefaults(sections: ConceptionSection[]) { if (!this.state.busy) this.publish({defaultsDraft:clone(sections),defaultsDirty:true}); }
  saveSettings() { return this.run(async () => {}); }
  discardSettings() {
    if (this.state.busy) return;
    this.publish({sectionsDraft:clone(this.state.view?.sections ?? []),defaultsDraft:clone(this.state.defaults?.sections ?? []),sectionsDirty:false,defaultsDirty:false,error:null});
  }
  closeSettings() { return this.run(async () => this.publish({settingsOpen:false})); }
  showRecovery() {
    return this.run(async () => {
      if (!(await this.session.preserveForRecovery())) throw new Error(this.session.getSnapshot().error ?? compositionNotice);
      this.publish({candidates:await this.port.listRecovery(this.state.view!.workId),recoveryOpen:true,settingsOpen:false});
    },false);
  }
  recover(candidate: ConceptionRecoveryCandidate, asCopy: boolean) {
    return this.run(async () => {
      if (candidate.integrityError || (!asCopy && candidate.conflict)) throw new Error('请保留原记录并另存完整的构思草稿。');
      if (!(await this.session.preserveForRecovery())) throw new Error(this.session.getSnapshot().error ?? compositionNotice);
      const record = await this.port.recover(candidate.id,candidate.sequence,asCopy);
      const view = await this.port.view(this.state.view!.workId);
      this.session.loadRecovered(record);
      this.publish({view,recoveryOpen:false,settingsOpen:false,candidates:await this.port.listRecovery(view.workId),selectedSection:view.references.find(reference => reference.recordId === record.id)?.sectionId ?? null});
    },false);
  }
  closeRecovery() { this.publish({recoveryOpen:false}); }
  reset() {
    if (this.operation || this.state.busy || this.isComposing() || this.state.sectionsDirty || this.state.defaultsDirty) throw new Error('请先保存构思并等待操作完成，再切换资料库。');
    this.session.load(null); // Refuses a dirty or in-flight editor rather than dropping it.
    this.publish({view:null,selectedSection:null,settingsOpen:false,recoveryOpen:false,sectionsDraft:[],defaults:null,defaultsDraft:[],sectionsDirty:false,defaultsDirty:false,candidates:[],error:null});
  }
  dispose() { this.unsubscribe(); this.session.dispose(); this.listeners.clear(); }
}
export type { ConceptionRecord };
