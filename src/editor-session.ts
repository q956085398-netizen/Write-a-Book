import { errorText, type Chapter, type ApplicationPort } from './model';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';
export interface EditorSnapshot { chapter: Chapter | null; status: SaveStatus; error: string | null }

// One authoring session, one serialized writer. The UI and close barrier share this service.
export class EditorSession {
  private state: EditorSnapshot = { chapter: null, status: 'saved', error: null };
  private persisted: Chapter | null = null;
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private continuousTimer: ReturnType<typeof setTimeout> | undefined;
  private composing = false;
  private attachmentTasks = new Set<Promise<unknown>>();
  private continuousDue = false;
  constructor(private readonly port: Pick<ApplicationPort, 'saveChapter'>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: EditorSnapshot) { this.state = next; this.listeners.forEach(listener => listener()); }
  private dirty() {
    const current = this.state.chapter;
    return current !== null && (current.body !== this.persisted?.body || current.title !== this.persisted?.title || current.bodyFormat !== this.persisted?.bodyFormat);
  }
  private clearTimers() {
    clearTimeout(this.idleTimer); clearTimeout(this.continuousTimer);
    this.idleTimer = undefined; this.continuousTimer = undefined; this.continuousDue = false;
  }
  load(chapter: Chapter | null) {
    if (this.pending || this.dirty()) throw new Error('请先保存当前章节。');
    this.clearTimers(); this.composing = false;
    this.persisted = chapter;
    this.publish({ chapter, status: 'saved', error: null });
  }
  edit(field: 'title' | 'body', value: string) {
    if (!this.state.chapter) return;
    this.publish({ chapter: { ...this.state.chapter, [field]: value }, status: 'unsaved', error: null });
    this.schedule();
  }
  editDocument(body: string) {
    if (!this.state.chapter) return;
    this.publish({ chapter: { ...this.state.chapter, body, bodyFormat: 'wab-rich-v1' }, status: 'unsaved', error: null });
    this.schedule();
  }
  beginComposition() { this.composing = true; clearTimeout(this.idleTimer); }
  endComposition() { this.composing = false; if (this.continuousDue) void this.flush(); else this.schedule(); }
  private schedule() {
    clearTimeout(this.idleTimer);
    if (!this.composing) this.idleTimer = setTimeout(() => void this.flush(), 1000);
    this.continuousTimer ??= setTimeout(() => {
      this.continuousTimer = undefined;
      if (this.composing) this.continuousDue = true; else void this.flush();
    }, 5000);
  }
  trackAttachment<T>(task: Promise<T>): Promise<T> {
    this.attachmentTasks.add(task);
    void task.finally(() => this.attachmentTasks.delete(task)).catch(() => {});
    return task;
  }
  async flush(): Promise<boolean> {
    this.clearTimers();
    if (this.composing) return false;
    try {
      if (this.attachmentTasks.size) await Promise.all(this.attachmentTasks);
      while (this.dirty() || this.pending) {
        if (this.composing) return false;
        if (this.pending) { await this.pending; continue; }
        const snapshot = this.state.chapter!;
        this.publish({ ...this.state, status: 'saving', error: null });
        this.pending = this.port.saveChapter({
          id: snapshot.id, contentId: snapshot.contentId, title: snapshot.title,
          body: snapshot.body, bodyFormat: snapshot.bodyFormat, expectedRevision: snapshot.revision,
        }).then(saved => {
          this.persisted = saved;
          // Keep text typed during the write; only advance the acknowledged revision.
          this.publish({ chapter: { ...this.state.chapter!, revision: saved.revision },
            status: this.state.chapter?.body === saved.body && this.state.chapter?.title === saved.title && this.state.chapter?.bodyFormat === saved.bodyFormat ? 'saved' : 'unsaved',
            error: null });
        }).finally(() => { this.pending = null; });
        await this.pending;
      }
      this.publish({ ...this.state, status: 'saved', error: null });
      return true;
    } catch (error) {
      this.publish({ ...this.state, status: 'error', error: errorText(error) });
      return false;
    }
  }
  dispose() { this.clearTimers(); this.listeners.clear(); }
}
