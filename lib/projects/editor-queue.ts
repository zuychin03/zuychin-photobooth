import type { PhotoProject, ProjectEditorSettings, ProjectScope } from "./model";

export interface ProjectEditorQueueState {
  readonly editor: ProjectEditorSettings;
  readonly pending: boolean;
  readonly error: string | null;
}
type PersistEditor = (patch: Partial<ProjectEditorSettings>) => Promise<void>;

function snapshot(editor: ProjectEditorSettings): ProjectEditorSettings {
  const copy = structuredClone(editor);
  function freeze(value: unknown) {
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  freeze(copy);
  return copy;
}

export class ProjectEditorQueue {
  private editor: ProjectEditorSettings;
  private version = 0;
  private savedVersion = 0;
  private inFlight: Promise<void> | null = null;
  private error: string | null = null;
  private disposed = false;
  private retired = false;
  private lifecycle = 0;
  private listeners = new Set<() => void>();
  private state: ProjectEditorQueueState;
  private committedEditor: ProjectEditorSettings;

  constructor(initial: ProjectEditorSettings, private persist: PersistEditor, private reserveRecovery: () => void = () => {}) {
    this.editor = snapshot(initial);
    this.committedEditor = this.editor;
    this.state = Object.freeze({ editor: this.editor, pending: false, error: null });
  }
  readonly getSnapshot = (): ProjectEditorQueueState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  setPersist(persist: PersistEditor): void { this.persist = persist; }
  activate(): void { if (this.retired) return; this.disposed = false; if (!this.error) this.startWrite(); }
  detach(): void { if (!this.error) this.startWrite(); }
  dispose(): void { this.disposed = true; }

  private publish(): void {
    this.state = Object.freeze({ editor: this.editor, pending: this.version !== this.savedVersion, error: this.error });
    if (!this.disposed) this.listeners.forEach(listener => listener());
  }
  private startWrite(): void {
    if (this.disposed || this.inFlight || this.version === this.savedVersion) return;
    const version = this.version, editor = this.editor, persist = this.persist, lifecycle = this.lifecycle;
    this.error = null;
    const task = Promise.resolve().then(() => {
      if (this.disposed) throw new Error("The editor was closed before this change could be saved");
      return persist(editor);
    }).then(() => {
      if (lifecycle !== this.lifecycle) { this.inFlight = null; return; }
      this.savedVersion = version;
      this.committedEditor = editor;
      this.inFlight = null;
      this.error = null;
      this.publish();
      this.startWrite();
    }, error => {
      this.inFlight = null;
      if (lifecycle !== this.lifecycle) return;
      this.error = error instanceof Error ? error.message : "Changes could not be saved on this device";
      this.publish();
      throw error;
    });
    this.inFlight = task;
    void task.catch(() => {});
    this.publish();
  }
  patch(patch: Partial<ProjectEditorSettings>): void {
    if (this.disposed) throw new Error("This editor is closed");
    const next = snapshot({ ...this.editor, ...patch });
    try { this.reserveRecovery(); }
    catch (error) {
      this.error = error instanceof Error ? error.message : "Save another open draft before editing this project";
      this.publish(); return;
    }
    this.editor = next;
    this.version++;
    this.error = null;
    this.publish();
    this.startWrite();
  }
  setField<K extends keyof ProjectEditorSettings>(key: K, value: ProjectEditorSettings[K] | ((previous: ProjectEditorSettings[K]) => ProjectEditorSettings[K])): void {
    const next = typeof value === "function" ? (value as (previous: ProjectEditorSettings[K]) => ProjectEditorSettings[K])(this.editor[key]) : value;
    this.patch({ [key]: next } as Pick<ProjectEditorSettings, K>);
  }
  async flush(): Promise<void> {
    if (this.disposed) throw new Error("This editor is closed");
    while (this.version !== this.savedVersion) {
      this.startWrite();
      await this.inFlight;
      if (this.disposed) throw new Error("This editor was closed before saving finished");
    }
  }
  replaceFromProject(editor: ProjectEditorSettings): void {
    if (this.inFlight || this.version !== this.savedVersion) throw new Error("Save pending changes before restoring project history");
    this.editor = snapshot(editor);
    this.committedEditor = this.editor;
    this.error = null;
    this.publish();
  }
  discardUnsaved(durableEditor: ProjectEditorSettings = this.committedEditor): void {
    if (this.inFlight) throw new Error("Wait for the current save to finish before discarding unsaved edits");
    this.editor = snapshot(durableEditor);
    this.committedEditor = this.editor;
    this.version = this.savedVersion;
    this.error = null;
    this.publish();
  }
  async retireAndDrain(): Promise<void> {
    this.retired = true; this.disposed = true; this.lifecycle++;
    await this.inFlight?.catch(() => {});
    this.editor = this.committedEditor; this.version = this.savedVersion; this.error = null;
    this.publish();
  }
}

export class ProjectEditorRecoveryRegistry {
  private entries = new Map<string, ProjectEditorQueue>();
  private subscriptions = new Map<string, () => void>();
  constructor(private limit = 8, private onPendingChange: (count: number) => void = () => {}) {}
  get size(): number { return this.entries.size; }
  acquire(identity: string, editor: ProjectEditorSettings, persist: PersistEditor): ProjectEditorQueue {
    const retained = this.entries.get(identity);
    if (retained) return retained;
    const queue = new ProjectEditorQueue(editor, persist, () => {
      if (this.entries.get(identity) === queue) return;
      if (this.entries.has(identity)) throw new Error("This project already has an unsaved editor. Reopen it before editing.");
      if (this.entries.size >= this.limit) throw new Error(`There are ${this.limit} unsaved projects in this tab. Save or discard one before editing another.`);
      this.entries.set(identity, queue);
      const unsubscribe = queue.subscribe(() => {
        if (queue.getSnapshot().pending) return;
        this.entries.delete(identity);
        unsubscribe();
        this.subscriptions.delete(identity);
        this.onPendingChange(this.entries.size);
      });
      this.subscriptions.set(identity, unsubscribe);
      this.onPendingChange(this.entries.size);
    });
    return queue;
  }
  async discardIdentity(identity: string): Promise<void> {
    const queue = this.entries.get(identity);
    if (!queue) return;
    await queue.retireAndDrain();
    if (this.entries.get(identity) !== queue) return;
    this.subscriptions.get(identity)?.(); this.subscriptions.delete(identity);
    this.entries.delete(identity); this.onPendingChange(this.entries.size);
  }
  async flushIdentity(identity: string): Promise<void> {
    await this.entries.get(identity)?.flush();
  }
  async discardScope(scope: ProjectScope): Promise<void> {
    const prefix = JSON.stringify([scope.kind, scope.kind === "account" ? scope.ownerId : null]).slice(0, -1) + ",";
    await Promise.all([...this.entries.keys()].filter(identity => identity.startsWith(prefix)).map(identity => this.discardIdentity(identity)));
  }
}

export function projectEditorIdentity(project: Pick<PhotoProject, "id" | "scope">): string {
  return JSON.stringify([project.scope.kind, project.scope.kind === "account" ? project.scope.ownerId : null, project.id]);
}

const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
export const projectEditorRecovery = new ProjectEditorRecoveryRegistry(8, count => {
  if (typeof window === "undefined") return;
  if (count) window.addEventListener("beforeunload", warnBeforeUnload);
  else window.removeEventListener("beforeunload", warnBeforeUnload);
});
export function discardProjectEditorRecovery(project: Pick<PhotoProject, "id" | "scope">): Promise<void> { return projectEditorRecovery.discardIdentity(projectEditorIdentity(project)); }
export function discardProjectEditorRecoveryScope(scope: ProjectScope): Promise<void> { return projectEditorRecovery.discardScope(scope); }
