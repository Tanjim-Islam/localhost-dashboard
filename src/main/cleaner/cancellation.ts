export class CleanerCancelledError extends Error {
  constructor() {
    super("Cleaner scan was cancelled.");
    this.name = "CleanerCancelledError";
  }
}

export class CleanerCancellationToken {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CleanerCancelledError();
  }

  onCancelled(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
