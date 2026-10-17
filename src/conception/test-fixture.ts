import { vi } from 'vitest';
import type { ConceptionDefaults, ConceptionPort, ConceptionRecord, ConceptionSection, ConceptionView } from './types';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function fixture() {
  let nextId=0;
  const views: Record<string,ConceptionView>={
    a:{workId:'a',workTitle:'当前书',revision:0,sections:[{id:'a-core',name:'故事核心',hidden:false},{id:'a-ending',name:'结局储备',hidden:false}],records:[],references:[]},
    b:{workId:'b',workTitle:'另一书',revision:0,sections:[{id:'b-core',name:'另一书分区',hidden:false}],records:[],references:[]},
  };
  let defaults: ConceptionDefaults={revision:0,sections:[{id:'default',name:'以后新书',hidden:false}]};
  const journal: Parameters<ConceptionPort['checkpoint']>[0][]=[];
  const port: ConceptionPort={
    view:vi.fn(async workId => copy(views[workId])),
    defaults:vi.fn(async () => copy(defaults)),
    changeDefaults:vi.fn(async (_revision,sections) => {defaults={revision:defaults.revision+1,sections:copy(sections)};return copy(defaults);}),
    changeSections:vi.fn(async (workId,_revision,sections) => {if (sections.some((section: ConceptionSection) => !section.name.trim())) throw new Error('分区名称不能为空');views[workId]={...views[workId],sections:copy(sections),revision:views[workId].revision+1};return copy(views[workId]);}),
    create:vi.fn(async (workId,sectionId) => {const id=`record-${++nextId}`;const record: ConceptionRecord={id,workId,contentId:`content-${id}`,title:'',body:'',bodyFormat:'plain-text',revision:0};views[workId].records.push(record);views[workId].references.push({id:`ref-${nextId}`,recordId:id,sectionId});return copy(record);}),
    reference:vi.fn(async (workId,recordId,sectionId) => {views[workId].references.push({id:`ref-${++nextId}`,recordId,sectionId});return copy(views[workId]);}),
    save:vi.fn(async draft => {const view=Object.values(views).find(view => view.records.some(record => record.id===draft.id))!;const current=view.records.find(record => record.id===draft.id)!;const saved={...current,...draft,bodyFormat:draft.bodyFormat ?? 'plain-text',revision:current.revision+1};view.records=view.records.map(record => record.id===saved.id ? saved : record);return copy(saved);}),
    checkpoint:vi.fn(async snapshot => {journal.push(copy(snapshot));}),
    acknowledge:vi.fn(async () => {}),listRecovery:vi.fn(async () => []),recover:vi.fn(async () => {throw new Error('No candidate selected');}),
    importImage:vi.fn(async () => ({id:'12345678-1234-1234-1234-123456789abc',name:'构思图.png',mime:'image/png',size:4})),
    readImage:vi.fn(async () => 'data:image/png;base64,AA=='),
  };
  return {port,views,journal};
}
