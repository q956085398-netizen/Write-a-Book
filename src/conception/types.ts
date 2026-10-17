export interface ConceptionSection { id: string; name: string; hidden: boolean }
export interface ConceptionRecord { id: string; workId: string; contentId: string; title: string; body: string; bodyFormat: string; revision: number }
export interface SaveConception { id: string; contentId: string; title: string; body: string; bodyFormat?: string; expectedRevision: number }
export interface ConceptionReference { id: string; recordId: string; sectionId: string }
export interface ConceptionView { workId: string; workTitle: string; revision: number; sections: ConceptionSection[]; records: ConceptionRecord[]; references: ConceptionReference[] }
export interface ConceptionDefaults { revision: number; sections: ConceptionSection[] }
export interface ConceptionRecoveryDraft { sessionId: string; sequence: number; base: ConceptionRecord; draft: SaveConception }
export interface ConceptionRecoveryCandidate { id: string; sequence: number; draft: SaveConception; base: ConceptionRecord; current: ConceptionRecord | null; conflict: boolean; integrityError: string | null }
export interface ConceptionPort {
  view(workId: string): Promise<ConceptionView>;
  defaults(): Promise<ConceptionDefaults>;
  changeDefaults(expectedRevision: number, sections: ConceptionSection[]): Promise<ConceptionDefaults>;
  changeSections(workId: string, expectedRevision: number, sections: ConceptionSection[]): Promise<ConceptionView>;
  create(workId: string, sectionId: string): Promise<ConceptionRecord>;
  reference(workId: string, recordId: string, sectionId: string): Promise<ConceptionView>;
  save(draft: SaveConception): Promise<ConceptionRecord>;
  checkpoint(snapshot: ConceptionRecoveryDraft): Promise<void>;
  acknowledge(sessionId: string, contentId: string, sequence: number): Promise<void>;
  listRecovery(workId: string): Promise<ConceptionRecoveryCandidate[]>;
  recover(id: string, sequence: number, asCopy: boolean): Promise<ConceptionRecord>;
  importImage(contentId: string, name: string, bytes: number[]): Promise<{id: string; name: string; mime: string; size: number}>;
  readImage(contentId: string, id: string): Promise<string>;
}
