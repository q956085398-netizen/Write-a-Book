export interface ExportEntry { id: string; contentId: string; title: string; volumeTitle: string | null; volumeId: string | null }
export interface ExportManifest { workId: string; title: string; structureRevision: number; chapters: ExportEntry[]; fragments: ExportEntry[] }
export type ExportScope = { type: 'current'; entryId: string } | { type: 'selected'; entryIds: string[] } | { type: 'book' };
export interface FragmentPlacement { entryId: string; beforeEntryId: string | null }
export interface ExportRequest { workId: string; expectedStructureRevision: number; scope: ExportScope; fragments: FragmentPlacement[]; format: 'docx' | 'txt'; target: string; acknowledgeTxtLoss: boolean; replaceExisting: boolean }
export interface ExportReceipt { path: string; bytes: number; chapterCount: number; fragmentCount: number; imageCount: number; structureRevision: number; contentRevisions: { contentId: string; revision: number }[] }
export interface ExportPort {
  manifest(workId: string): Promise<ExportManifest>;
  chooseTarget(format: 'docx' | 'txt', suggestedName: string): Promise<string | null>;
  export(request: ExportRequest): Promise<ExportReceipt>;
}
export function selectedChapters(manifest: ExportManifest, scope: ExportScope): ExportEntry[] {
  return manifest.chapters.filter(entry => scope.type === 'book' || (scope.type === 'current' ? scope.entryId === entry.id : scope.entryIds.includes(entry.id)));
}
export function buildExportRequest(manifest: ExportManifest, scope: ExportScope, placements: Record<string, string>, format: 'docx' | 'txt', target: string, acknowledgeTxtLoss: boolean, replaceExisting: boolean): ExportRequest {
  const selected = selectedChapters(manifest, scope);
  if (scope.type === 'current' && !selected.length) throw new Error('当前记录是正文片段，请主动选择片段及位置。');
  const fragments: FragmentPlacement[] = manifest.fragments.filter(entry => Object.hasOwn(placements, entry.id)).map(entry => {
    const anchor = placements[entry.id];
    if (!anchor) throw new Error('请为每个已选片段指定插入位置。');
    if (anchor !== '__end__' && !selected.some(chapter => chapter.id === anchor)) throw new Error('片段位置不在已选章节中，请重新指定。');
    return { entryId: entry.id, beforeEntryId: anchor === '__end__' ? null : anchor };
  });
  if (!selected.length && !fragments.length) throw new Error('请至少选择一个章节或正文片段。');
  if (format === 'txt' && !acknowledgeTxtLoss) throw new Error('请先确认 TXT 不保留图片和文字样式。');
  if (!target) throw new Error('请先选择导出文件位置。');
  return { workId: manifest.workId, expectedStructureRevision: manifest.structureRevision, scope, fragments, format, target, acknowledgeTxtLoss, replaceExisting };
}
