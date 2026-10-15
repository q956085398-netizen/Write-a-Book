export interface Work { id: string; title: string }
export interface Chapter { id: string; workId: string; contentId: string; title: string; body: string; revision: number }
export interface LibraryView { path: string; works: Work[]; chapter: Chapter | null }
export interface Bootstrap { defaultPath: string; library: LibraryView | null; restoreError: string | null }
export interface SaveChapter { id: string; contentId: string; title: string; body: string; expectedRevision: number }
export interface ApplicationPort {
  bootstrap(): Promise<Bootstrap>;
  openLibrary(path: string): Promise<LibraryView>;
  createWork(title: string): Promise<LibraryView>;
  selectWork(id: string): Promise<Chapter>;
  saveChapter(draft: SaveChapter): Promise<Chapter>;
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const characterCount = (text: string): number => Array.from(text.replace(/\s/gu, '')).length;
