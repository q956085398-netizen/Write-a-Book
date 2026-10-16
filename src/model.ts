export interface Work { id: string; title: string }
export interface Chapter { id: string; workId: string; contentId: string; title: string; body: string; bodyFormat?: string; revision: number }
export interface LibraryView { path: string; works: Work[]; chapter: Chapter | null }
export interface Bootstrap { defaultPath: string; library: LibraryView | null; restoreError: string | null }
export interface SaveChapter { id: string; contentId: string; title: string; body: string; bodyFormat?: string; expectedRevision: number }
export interface RecoveryDraft { sessionId: string; sequence: number; base: Chapter; draft: SaveChapter }
export interface RecoveryCandidate { id: string; sequence: number; draft: SaveChapter; base: Chapter; current: Chapter | null; conflict: boolean; integrityError: string | null }
export interface ApplicationPort {
  checkpointChapter(snapshot: RecoveryDraft): Promise<void>;
  acknowledgeRecovery(sessionId: string, contentId: string, sequence: number): Promise<void>;
  listRecovery(): Promise<RecoveryCandidate[]>;
  recoverChapter(id: string, sequence: number, asCopy: boolean): Promise<LibraryView>;
  importImage(contentId: string, name: string, bytes: number[]): Promise<Attachment>;
  readImage(contentId: string, id: string): Promise<string>;
  bootstrap(): Promise<Bootstrap>;
  openLibrary(path: string): Promise<LibraryView>;
  createWork(title: string): Promise<LibraryView>;
  selectWork(id: string): Promise<Chapter>;
  saveChapter(draft: SaveChapter): Promise<Chapter>;
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const characterCount = (text: string): number => Array.from(text.replace(/\s/gu, '')).length;

export interface Attachment { id: string; name: string; mime: string; size: number }
