import { errorText, type Chapter, type ApplicationPort, type RecoveryDraft } from './model';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';
export interface EditorSnapshot { chapter: Chapter | null; status: SaveStatus; error: string | null; recovery: 'pending' | 'retained' | 'error' | null }
type Persistence = Pick<ApplicationPort, 'saveChapter' | 'checkpointChapter' | 'acknowledgeRecovery'>;

// One editing session owns one ordered recovery stream and one serialized main writer.
export class EditorSession {
  private state: EditorSnapshot = { chapter: null, status: 'saved', error: null, recovery: null };
  private persisted: Chapter | null = null;
  private protectedDraft: Chapter | null = null;
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private journal: Promise<unknown> = Promise.resolve();
  private readonly sessionId = crypto.randomUUID();
  private sequence = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private continuousTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private composing = false;
  private attachmentTasks = new Set<Promise<unknown>>();
  private continuousDue = false;
  constructor(private readonly port: Persistence) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  isComposing = () => this.composing;
  private publish(next: EditorSnapshot) { this.state = next; this.listeners.forEach(listener => listener()); }
  private dirty() {
    const current = this.state.chapter;
    return current !== null && (current.body !== this.persisted?.body || current.title !== this.persisted?.title || current.bodyFormat !== this.persisted?.bodyFormat);
  }
  private clearTimers() {
    clearTimeout(this.idleTimer); clearTimeout(this.continuousTimer); clearTimeout(this.recoveryTimer); clearTimeout(this.retryTimer);
    this.idleTimer = undefined; this.continuousTimer = undefined; this.recoveryTimer = undefined; this.retryTimer = undefined; this.continuousDue = false;
  }
  load(chapter: Chapter | null) {
    if (this.pending || this.dirty()) throw new Error('请先保存当前章节。');
    this.clearTimers(); this.composing = false;
    this.persisted = chapter; this.protectedDraft = null;
    this.publish({ chapter, status: 'saved', error: null, recovery: null });
  }
  private changed(chapter: Chapter) {
    // An edit is not a successful retry: keep the failure visible until a real save receipt.
    this.publish({ ...this.state, chapter, status: this.state.error ? 'error' : 'unsaved', recovery: 'pending' });
    this.schedule();
  }
  edit(field: 'title' | 'body', value: string) {
    if (this.state.chapter) this.changed({ ...this.state.chapter, [field]: value });
  }
  editDocument(body: string) {
    if (this.state.chapter) this.changed({ ...this.state.chapter, body, bodyFormat: 'wab-rich-v1' });
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
    // This bounded checkpoint does not reset on every keystroke. It never persists IME candidates.
    this.recoveryTimer ??= setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.composing && !this.pending && this.dirty()) void this.checkpoint(this.state.chapter!).catch(() => {});
    }, 300);
  }
  private checkpoint(chapter: Chapter): Promise<number> {
    const sequence = ++this.sequence;
    const snapshot: RecoveryDraft = { sessionId: this.sessionId, sequence, base: this.persisted!, draft: {
      id: chapter.id, contentId: chapter.contentId, title: chapter.title, body: chapter.body,
      bodyFormat: chapter.bodyFormat, expectedRevision: chapter.revision,
    } };
    const job = this.journal.catch(() => {}).then(() => this.port.checkpointChapter(snapshot)).then(() => {
      this.protectedDraft = chapter;
      if (this.state.chapter?.body === chapter.body && this.state.chapter?.title === chapter.title) {
        this.publish({ ...this.state, recovery: 'retained' });
      }
      return sequence;
    }).catch(error => {
      this.publish({ ...this.state, status: 'error', recovery: 'error', error: `恢复草稿尚未写入：${errorText(error)}` });
      throw error;
    });
    this.journal = job;
    return job;
  }
  async preserveForRecovery(): Promise<boolean> {
    this.clearTimers();
    if (this.composing) return false;
    try {
      if (this.pending) await this.pending.catch(() => {});
      await this.journal.catch(() => {});
      if (this.attachmentTasks.size) await Promise.all(this.attachmentTasks);
      if (this.composing) return false;
      if (this.state.chapter && (this.dirty() || this.state.recovery) && !this.currentIsProtected()) await this.checkpoint(this.state.chapter);
      return !this.composing;
    } catch (error) {
      this.publish({ ...this.state, status: 'error', error: errorText(error) });
      return false;
    }
  }
  private currentIsProtected() {
    const current = this.state.chapter;
    const protectedDraft = this.protectedDraft;
    return !!current && !!protectedDraft && current.id === protectedDraft.id && current.contentId === protectedDraft.contentId
      && current.body === protectedDraft.body && current.title === protectedDraft.title
      && current.bodyFormat === protectedDraft.bodyFormat && current.revision === protectedDraft.revision;
  }
  loadRecovered(chapter: Chapter | null) {
    const current = this.state.chapter;
    if (this.composing || this.pending || (this.dirty() && !this.currentIsProtected())) {
      throw new Error('当前内容尚未完整留存，不能切换恢复版本。');
    }
    // Only this explicit recovery path may replace dirty memory; its exact draft remains durable.
    this.persisted = current;
    this.load(chapter);
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
      // Undoing back to the acknowledged text also supersedes an older recovery draft.
      if (!this.dirty() && !this.pending && this.state.chapter && this.state.recovery) {
        if (this.composing) return false;
        const snapshot = this.state.chapter;
        const sequence = await this.checkpoint(snapshot);
        await this.port.acknowledgeRecovery(this.sessionId, snapshot.contentId, sequence).catch(() => {});
      }
      while (this.dirty() || this.pending) {
        if (this.composing) return false;
        if (this.pending) { await this.pending; continue; }
        const snapshot = this.state.chapter!;
        this.publish({ ...this.state, status: 'saving' });
        this.pending = (async () => {
          const sequence = await this.checkpoint(snapshot);
          const saved = await this.port.saveChapter({
            id: snapshot.id, contentId: snapshot.contentId, title: snapshot.title,
            body: snapshot.body, bodyFormat: snapshot.bodyFormat, expectedRevision: snapshot.revision,
          });
          this.persisted = saved;
          this.publish({ chapter: { ...this.state.chapter!, revision: saved.revision },
            status: this.state.chapter?.body === saved.body && this.state.chapter?.title === saved.title && this.state.chapter?.bodyFormat === saved.bodyFormat ? 'saved' : 'unsaved',
            error: null, recovery: this.state.recovery });
          // Acknowledgement cleanup failure is harmless: reopening compares the full saved content.
          await this.port.acknowledgeRecovery(this.sessionId, snapshot.contentId, sequence).catch(() => {});
        })().finally(() => { this.pending = null; });
        await this.pending;
      }
      if (this.composing) return false;
      this.publish({ ...this.state, status: 'saved', error: null, recovery: null });
      return true;
    } catch (error) {
      this.publish({ ...this.state, status: 'error', error: errorText(error) });
      this.retryTimer ??= setTimeout(() => { this.retryTimer = undefined; void this.flush(); }, 5000);
      return false;
    }
  }
  dispose() { this.clearTimers(); this.listeners.clear(); }
}
