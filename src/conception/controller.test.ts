import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConceptionController } from './controller';
import type { ConceptionPort, ConceptionSection } from './types';
import { fixture } from './test-fixture';
const controllers: ConceptionController[]=[];
function controller(port: ConceptionPort) {const value=new ConceptionController(port);controllers.push(value);return value;}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {controllers.splice(0).forEach(controller => controller.dispose());vi.useRealTimers();});
it('creates an immediately editable record, references its stable identity and preserves edits when changing books',async () => {
  const {port,views}=fixture();const c=controller(port);
  expect(await c.openWork('a')).toBe(true);expect(await c.create()).toBe(true);
  const id=c.getSnapshot().editor.chapter!.id;
  c.session.edit('body','从结局开始，一句话就够。');c.session.edit('title','留下');
  expect(await c.reference('a-ending')).toBe(true);
  expect(views.a.records).toHaveLength(1);expect(views.a.references.filter(ref => ref.recordId===id)).toHaveLength(2);
  expect(await c.openRecord(id,'a-ending')).toBe(true);expect(c.getSnapshot().editor.chapter!.body).toBe('从结局开始，一句话就够。');
  c.session.edit('body','两处分区看到同一份修改。');
  expect(await c.openWork('b')).toBe(true);expect(views.a.records[0].body).toBe('两处分区看到同一份修改。');
  expect(c.getSnapshot().view?.workTitle).toBe('另一书');expect(views.b.records).toEqual([]);
});
it('opens hidden content directly without changing the hidden flag or auto-restoring its directory',async () => {
  const {port,views}=fixture();const c=controller(port);
  await c.openWork('a');await c.create();const id=c.getSnapshot().editor.chapter!.id;
  await c.openSettings();c.editSections(c.getSnapshot().sectionsDraft.map(section => ({...section,hidden:section.id==='a-core'})));
  expect(await c.saveSettings()).toBe(true);
  expect(await c.openRecord(id,'a-core')).toBe(true);
  expect(c.getSnapshot().selectedSection).toBe('a-core');expect(views.a.sections[0].hidden).toBe(true);
  expect(port.changeSections).toHaveBeenCalledTimes(1);
});
it('flush waits for image insertion and persists both current book and future defaults before allowing a leave',async () => {
  const {port,views}=fixture();const c=controller(port);await c.openWork('a');await c.create();await c.openSettings();
  const next: ConceptionSection[]=[{id:'new',name:'随便写写',hidden:false}];
  c.editSections([...c.getSnapshot().sectionsDraft,...next]);c.editDefaults(next);
  let finish!: () => void;
  const image=new Promise<void>(resolve => {finish=resolve;});
  c.session.trackAttachment(image.then(() => c.session.edit('body','图片插入后的完整文字')));
  let settled=false;const closing=c.flush().then(result => {settled=result;return result;});
  await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);expect(port.save).not.toHaveBeenCalled();
  finish();expect(await closing).toBe(true);
  expect(views.a.records[0].body).toBe('图片插入后的完整文字');
  expect(views.a.sections.at(-1)?.name).toBe('随便写写');expect((await port.defaults()).sections).toEqual(next);
  expect(c.getSnapshot().sectionsDirty).toBe(false);expect(c.getSnapshot().defaultsDirty).toBe(false);
});
it('refuses IME navigation and library reset while dirty, then safely clears old identities after a successful flush',async () => {
  const {port}=fixture();const c=controller(port);await c.openWork('a');await c.create();
  c.session.beginComposition();c.session.edit('body','组合候选');
  expect(await c.openWork('b')).toBe(false);expect(await c.flush()).toBe(false);expect(port.checkpoint).not.toHaveBeenCalled();
  c.session.endComposition();expect(() => c.reset()).toThrow();
  expect(c.getSnapshot().view?.workId).toBe('a');expect(await c.flush()).toBe(true);
  c.reset();expect(c.getSnapshot().view).toBeNull();expect(c.getSnapshot().editor.chapter).toBeNull();expect(c.getSnapshot().defaults).toBeNull();
});
it('failed main saves keep input and complete recovery drafts, block leaving, and can recover as an independent copy',async () => {
  const {port,journal,views}=fixture();const c=controller(port);await c.openWork('a');await c.create();
  c.session.edit('body','未写进主库的最后一句。');
  vi.mocked(port.save).mockRejectedValue(new Error('受控主库失败'));
  expect(await c.openWork('b')).toBe(false);expect(c.getSnapshot().view?.workId).toBe('a');
  expect(c.getSnapshot().editor.chapter!.body).toBe('未写进主库的最后一句。');expect(c.getSnapshot().editor.status).toBe('error');
  const snapshot=journal.at(-1)!;const candidate={id:'recovery',sequence:snapshot.sequence,base:snapshot.base,draft:snapshot.draft,current:snapshot.base,conflict:true,integrityError:null};
  vi.mocked(port.listRecovery).mockResolvedValue([candidate]);
  expect(await c.showRecovery()).toBe(true);expect(c.getSnapshot().recoveryOpen).toBe(true);
  const record={...snapshot.base,id:'copy',contentId:'copied-content',body:snapshot.draft.body,revision:0};
  vi.mocked(port.recover).mockImplementation(async () => {views.a.records.push(record);views.a.references.push({id:'copy-ref',recordId:record.id,sectionId:'a-core'});return record;});
  expect(await c.recover(candidate,true)).toBe(true);expect(c.getSnapshot().editor.chapter?.contentId).toBe('copied-content');
  expect(views.a.records[0].body).toBe('');expect(c.getSnapshot().editor.status).toBe('saved');
});
it('keeps invalid setting input visible and blocks closing until it is corrected or explicitly withdrawn',async () => {
  const {port}=fixture();const c=controller(port);await c.openWork('a');await c.openSettings();
  c.editSections(c.getSnapshot().sectionsDraft.map((section,index) => index===0 ? {...section,name:''} : section));
  expect(await c.flush()).toBe(false);expect(c.getSnapshot().error).toContain('不能为空');expect(c.getSnapshot().sectionsDraft[0].name).toBe('');
  expect(c.getSnapshot().sectionsDirty).toBe(true);c.discardSettings();expect(await c.flush()).toBe(true);
});
