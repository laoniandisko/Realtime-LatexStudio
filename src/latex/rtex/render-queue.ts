/** A single render worker. Updates replace pending work instead of appending jobs. */
export class PageRenderQueue {
  private dirty = new Map<number, number>();
  private revision = 0;
  private epoch = 0;
  private running = false;
  private frame = 0;
  constructor(private options: {
    enabled(): boolean;
    visible(): number[];
    paint(page: number, current: () => boolean): Promise<void>;
    error(error: Error): void;
    frame?(callback: () => void): number;
    cancelFrame?(id: number): void;
    yield?(): Promise<void>;
  }) {}
  request(pages: Iterable<number> = []) {
    for (const page of pages) this.dirty.set(page, ++this.revision);
    // Scroll/resize notifications also call request() to expose deferred pages.
    // Once all pages are clean, those notifications need no frame or DOM reads.
    if (!this.dirty.size || !this.options.enabled() || this.running || this.frame) return;
    this.frame = (this.options.frame || requestAnimationFrame)(() => { this.frame = 0; void this.drain(); });
  }
  reset() {
    this.epoch++; this.dirty.clear();
    if (this.frame) (this.options.cancelFrame || cancelAnimationFrame)(this.frame);
    this.frame = 0;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    try {
      while (this.options.enabled() && epoch === this.epoch) {
        const page = this.options.visible().find(page => this.dirty.has(page));
        if (page === undefined) break;
        const revision = this.dirty.get(page);
        const current = () => this.options.enabled() && epoch === this.epoch && this.dirty.get(page) === revision;
        try { await this.options.paint(page, current); }
        catch (error) { if (current()) this.options.error(error as Error); }
        if (current()) this.dirty.delete(page);
        await (this.options.yield?.() || new Promise<void>(resolve => setTimeout(resolve, 0)));
      }
    } finally {
      this.running = false;
      if (this.dirty.size && this.options.enabled() && this.options.visible().some(page => this.dirty.has(page))) this.request();
    }
  }
}

export function nearViewport(top: number, bottom: number, viewportTop: number, viewportBottom: number) {
  return bottom >= viewportTop - 160 && top <= viewportBottom + 160;
}
