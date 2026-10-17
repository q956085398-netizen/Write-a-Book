import { describe, expect, it } from 'vitest';
import { buildExportRequest, selectedChapters, type ExportManifest } from './export-port';
const manifest: ExportManifest = { workId: 'work', title: '中文', structureRevision: 9, chapters: [{ id: 'b', contentId: 'cb', title: '第一章', volumeTitle: '卷一', volumeId: 'v' }, { id: 'a', contentId: 'ca', title: '第二章', volumeTitle: null, volumeId: null }], fragments: [{ id: 'f', contentId: 'cf', title: '未编片段', volumeTitle: null, volumeId: null }] };
describe('manuscript export selection boundary', () => {
  it('uses directory order despite reverse selection and never includes fragments implicitly', () => {
    expect(selectedChapters(manifest, { type: 'selected', entryIds: ['a', 'b'] }).map(e => e.id)).toEqual(['b', 'a']);
    expect(buildExportRequest(manifest, { type: 'book' }, {}, 'docx', 'C:/稿.docx', false, false).fragments).toEqual([]);
  });
  it('requires explicit placement and revalidates after scope changes', () => {
    expect(() => buildExportRequest(manifest, { type: 'book' }, { f: '' }, 'docx', 'C:/稿.docx', false, false)).toThrow('位置');
    expect(() => buildExportRequest(manifest, { type: 'current', entryId: 'a' }, { f: 'b' }, 'docx', 'C:/稿.docx', false, false)).toThrow('已选章节');
    expect(buildExportRequest(manifest, { type: 'selected', entryIds: [] }, { f: '__end__' }, 'docx', 'C:/稿.docx', false, false).fragments).toEqual([{ entryId: 'f', beforeEntryId: null }]);
  });
  it('requires TXT loss confirmation and rejects empty scope and current fragments', () => {
    expect(() => buildExportRequest(manifest, { type: 'book' }, {}, 'txt', 'C:/稿.txt', false, false)).toThrow('TXT');
    expect(() => buildExportRequest(manifest, { type: 'selected', entryIds: [] }, {}, 'docx', 'C:/稿.docx', false, false)).toThrow('至少选择');
    expect(() => buildExportRequest(manifest, { type: 'current', entryId: 'f' }, {}, 'docx', 'C:/稿.docx', false, false)).toThrow('片段');
    expect(buildExportRequest(manifest, { type: 'book' }, {}, 'txt', 'C:/稿.txt', true, true)).toMatchObject({ expectedStructureRevision: 9, acknowledgeTxtLoss: true, replaceExisting: true });
  });
});
