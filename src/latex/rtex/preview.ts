import { getDocument, type PDFDocumentProxy, type PDFDocumentLoadingTask } from 'pdfjs-dist';
import { FontStore, ImageStore, Painter, inexactReason } from './vendor/render';
import { PreviewModel } from './vendor/model';
import { words, type TextRow, type Word } from './vendor/textLayer';
import { glyphTextOf } from './vendor/glyphMap';
import { SP_PER_BP, type Span } from './vendor/protocol';
import { escapeLatexText, type SourceFile } from '../source-map';
import { mapPlainWord } from './mapping';
import { paragraphTarget, formulaTarget, mathRegions, type BlockTarget } from './block-edit';
import { PageBlockEditor } from './block-editor';
import { PageRenderQueue, nearViewport } from './render-queue';
import { decodeBase64 as bytes } from '../binary';
import { SourceBindings, rebaseTarget } from './source-bindings';
import { UnitAnalyzer, sameRows, isAnalysisCancelled } from './analysis-client';
import { pdfEditTargets } from '../pdf-target';
import { reconcileNodes } from './reconcile';
import { PageEditor } from './page-editor';
import { visualText } from './visual-text';
import type { UnitAnalysis } from './analyze-unit';
import { selectionAfterEdit } from './editor-navigation';
import { moveParagraph, type FileChange } from './paragraph-move';
import { moveObject, objectMoveTarget } from './object-move';
import { sourceSupportsGraphics } from './graphics-support';
import { PageObjectEditor } from './object-editor';
import { graphics, imageRectangles, type ObjectRegion } from './object-edit';
import { paintRasterFrame } from './raster-frame';
import { overlaySafety, hasStructuredInk } from './overlay-safety';
import type { Overlay } from './vendor/model';

interface Options {
  container: HTMLElement; viewport: HTMLElement;
  token(): string; main(): string; files(): SourceFile[];
  status(text: string, kind: 'busy' | 'live' | 'ready' | 'error' | 'off'): void;
  pages(count: number): void;
  edit(file: string, from: number, to: number, expected: string, replacement: string): boolean;
  editBoundary(file: string): void;
  jump(file: string, offset: number): void;
  editing(): boolean; notify(text: string, error?: boolean): void;
  fallback(reason: string): void;
  log(text: string): void;
  beforeEdit?(): void;
  cursor?(file: string, from: number, to: number): void;
  editFiles?(changes: FileChange[]): boolean;
}
type Row = TextRow & { parId?: number; page: number; revision: number };

export class RealtimePreview {
  enabled = false;
  pageCount = 0;
  private socket: WebSocket | null = null;
  private model = new PreviewModel();
  private fonts = new FontStore();
  private images: ImageStore;
  private document: PDFDocumentProxy | null = null;
  private loadingPdf: PDFDocumentLoadingTask | null = null;
  private layoutTicket = 0;
  private spans = new Map<string, Span[]>();
  private bindings = new SourceBindings();
  private analyzer = new UnitAnalyzer();
  private targetSources = new WeakMap<BlockTarget, string>();
  private hitLayers = new Map<number,{ scale:number; groups:Map<number,{ rows:Row[]; source:string; nodes:Node[] }> }>();
  private shellsVersion = -1;
  private layoutRevision = 0;
  private layoutPages = new Map<number, any>();
  private bases = new Map<number, HTMLCanvasElement>();
  private renderQueue: PageRenderQueue;
  private rowCache = new Map<number, ReturnType<RealtimePreview['pageRows']>>();
  private rowsByUnit: Map<number, Row[]> | null = null;
  private receiveChain = Promise.resolve();
  private version = 0;
  private session = 0;
  private latestRevision = 0;
  private zoom = 0;
  private pending = new Map<string, string>();
  private inFlight: number | null = null;
  private sequence = 0;
  private exportPending = false;
  private layoutPending = false;
  private documentTimer: ReturnType<typeof setTimeout> | undefined;
  private documentSentAt = -Infinity;
  private inline: { input: HTMLInputElement; close(revert?: boolean): void } | null = null;
  private block: PageBlockEditor | null = null;
  private direct: PageEditor | null = null;
  private directOrigin: { target: BlockTarget; document: string } | null = null;
  private geometryUnits = new Map<number, { unit: NonNullable<ReturnType<RealtimePreview['unit']>>; analysis: UnitAnalysis }>();
  private activeUnit: number | null = null;
  private activeSource: { file: string; from: number } | null = null;
  private preservePdf = false;
  private sourceCursorTicket = 0;
  private nodeTargets = new WeakMap<HTMLElement,BlockTarget>();
  private draggedBlock: {target: BlockTarget;document: string}|null=null;
  private dragFrozenPages=new Set<number>();
  private object: PageObjectEditor|null=null;
  private objectOrigin: {target:BlockTarget;document:string;unit:number}|null=null;
  private orphanCacheRevision=-1;
  private orphanObjectCache:{region:ObjectRegion;target:BlockTarget}[]=[];
  private blockedOverlays=new Map<number,number>();
  private layoutRefreshTimer:ReturnType<typeof setTimeout>|undefined;
  private lastLayoutRequestRevision=0;

  constructor(private options: Options) {
    this.renderQueue = new PageRenderQueue({ enabled: () => this.enabled,
      visible: () => this.visiblePages(), paint: (page, current) => this.paintPage(page, current),
      error: error => this.options.notify(error.message, true) });
    this.images = new ImageStore(async (data, page) => {
      const doc = await getDocument({ data: data.slice(), isEvalSupported: false }).promise;
      try {
        const p = await doc.getPage(page); const view = p.getViewport({ scale: 2 }); const canvas = document.createElement('canvas'); canvas.width = view.width; canvas.height = view.height;
        await p.render({ canvasContext: canvas.getContext('2d')!, viewport: view }).promise; return canvas;
      } finally { await doc.destroy(); }
    });
    this.images.onLoaded = () => { this.rowCache.clear(); this.rowsByUnit = null; this.schedule(); };
    let viewportWidth = 0;
    new ResizeObserver(() => {
      if (!this.enabled) return;
      if (viewportWidth !== options.viewport.clientWidth) { viewportWidth = options.viewport.clientWidth; this.version++; this.bases.clear(); this.schedule(); }
      else this.renderQueue.request();
    }).observe(options.viewport);
    options.viewport.addEventListener('scroll', () => { this.inline?.close(); if (this.enabled) this.renderQueue.request(); }, { passive: true });
    options.container.ondragover=event=>this.dragOver(event);
    options.container.ondrop=event=>this.dropBlock(event);
  }
  async start(options: { preservePdf?: boolean } = {}) {
    this.stop(false); this.enabled = true; this.version++; this.latestRevision = 0;
    this.images.clear();
    void this.document?.destroy().catch(() => {}); this.document = null;
    this.model.clear(); this.layoutPages.clear(); this.bindings.clear(); this.rowCache.clear(); this.rowsByUnit = null; this.spans.clear(); this.hitLayers.clear(); this.bases.clear(); this.preservePdf = !!options.preservePdf; if (!this.preservePdf) this.options.container.replaceChildren(); this.fonts = new FontStore();
    this.status('正在连接实时引擎…', 'busy');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__latex/realtime?token=${encodeURIComponent(this.options.token())}`);
    this.socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', main: this.options.main(), documents: this.options.files() }));
    ws.onmessage = e => { if (ws !== this.socket) return; const packet = JSON.parse(e.data); this.receiveChain = this.receiveChain.then(() => { if (ws === this.socket) return this.receive(packet); }).catch(error => { this.status('实时预览错误', 'error'); this.options.notify(error.message, true); }); };
    ws.onerror = () => this.status('实时连接失败', 'error');
    ws.onclose = () => { if (ws === this.socket && this.enabled) this.status('实时连接已断开', 'error'); };
  }
  stop(notify = true) {
    clearTimeout(this.layoutRefreshTimer);this.layoutRefreshTimer=undefined;this.blockedOverlays.clear();this.lastLayoutRequestRevision=0;
    this.session++; this.analyzer.reset(); this.layoutTicket++; void this.loadingPdf?.destroy().catch(() => {}); this.loadingPdf = null;
    this.object?.close();this.clearBlockDrag();this.orphanCacheRevision=-1;this.orphanObjectCache=[];this.sourceCursorTicket++;this.direct?.close(); this.geometryUnits.clear(); this.block?.close();
    this.inline?.close(); clearTimeout(this.documentTimer); this.documentTimer = undefined; this.pending.clear(); this.inFlight = null; this.documentSentAt=-Infinity; this.layoutPending=false;this.exportPending = false; this.enabled = false; this.version++;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stop' }));
    this.socket?.close(); this.socket = null; this.renderQueue.reset();
    if (notify) this.status('实时预览已关闭', 'off');
  }
  documentChanged(file: string, text: string) {
    if (!this.enabled || !/\.(tex|bib|sty|cls)$/.test(file)) return;
    this.pending.set(file, text);
    if(this.inFlight===null&&this.documentTimer===undefined)this.flushDocuments();
  }
  private flushDocuments() {
    clearTimeout(this.documentTimer); this.documentTimer = undefined;
    if (!this.enabled || this.socket?.readyState !== WebSocket.OPEN || this.inFlight !== null) return;
    const next = this.pending.entries().next().value;
    if (next) {
      // Send an idle keystroke immediately. Under bursts, keep one request in flight
      // and coalesce newer text rather than adding 8ms to every ordinary edit.
      const remaining=8-(performance.now()-(this.documentSentAt??-Infinity));
      if(remaining>0){this.documentTimer=setTimeout(()=>{this.documentTimer=undefined;this.flushDocuments();},Math.ceil(remaining));return;}
      this.documentSentAt=performance.now();
      const [file,text] = next; this.pending.delete(file); this.inFlight = ++this.sequence;
      this.socket.send(JSON.stringify({ type: 'document', file, text, sequence: this.inFlight }));
    } else {
      if(this.layoutPending){this.layoutPending=false;this.lastLayoutRequestRevision=this.latestRevision;this.socket.send(JSON.stringify({type:'layout'}));}
      if(this.exportPending){this.exportPending = false; this.socket.send(JSON.stringify({ type: 'export' }));}
    }
  }
  requestLayout() {this.layoutPending=true;this.flushDocuments();}
  private refreshUnsafeLayout(){
    clearTimeout(this.layoutRefreshTimer);
    this.layoutRefreshTimer=setTimeout(()=>{
      this.layoutRefreshTimer=undefined;if(!this.enabled||!this.blockedOverlays.size)return;
      const required=Math.max(...this.blockedOverlays.values());if(required<=this.layoutRevision||required<=this.lastLayoutRequestRevision)return;
      this.requestLayout();
    },140);
  }
  private safeOverlay(overlay:Overlay,accepted:Iterable<Overlay>=this.model.overlays.values()){
    const binding=this.bindings.resolve(overlay.parId,overlay.revision),source=binding?.source.slice(binding.from,binding.to)||'';
    const structured=/\\(?:includegraphics\b|begin\s*\{\s*(?:figure|table)\*?\s*\}|begin\s*\{\s*tabular(?:x|\*)?\s*\})/.test(source);
    return overlaySafety({overlay,pages:this.model.pages,placements:this.model.placements,ownLines:(page,id)=>this.model.ownLines(page,id),otherOverlays:accepted,structured});
  }
  closeEditor() { this.object?.close(); this.direct?.close(); this.block?.close(); this.inline?.close(); }
  openTarget(target: BlockTarget, anchor: DOMRect) {
    if (!this.enabled) return;
    const offset = target.from;
    const file = this.options.files().find(f => f.name === target.file);
    if (!file) return;
    const byte = new TextEncoder().encode(file.content.slice(0, offset)).length;
    const span = this.spans.get(target.file)?.find(s => s.range.start <= byte && s.range.end >= byte);
    const id = span?.id ?? -1;
    if (target.kind !== 'source' && this.geometryUnits.has(id)) this.openDirect(target, id);
    else this.openBlock(target, anchor, id);
  }
  export() { this.closeEditor(); this.exportPending = true; this.flushDocuments(); this.status('正在完整导出 PDF…', 'busy'); }
  setZoom(value: number) { this.zoom = value; this.version++; this.bases.clear(); this.schedule(); }
  scrollToPage(page: number) { this.options.container.querySelector<HTMLElement>(`[data-page="${Math.max(1, Math.min(this.pageCount, page))}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  async focusSource(file: string, offset: number, scroll = true) {
    const source = this.options.files().find(f => f.name === file); if (!source) return;
    const ticket=++this.sourceCursorTicket;
    let best: {char: UnitAnalysis['characters'][number];distance: number}|undefined;
    const seen=new Set<number>();
    search:for(const pageNumber of this.model.pages.keys())for(const row of this.pageRows(pageNumber).rows){
      if(row.parId===undefined||seen.has(row.parId))continue;seen.add(row.parId);
      const unit=this.unit(row);if(!unit||unit.file!==file)continue;
      const oldOffset=selectionAfterEdit(source.content,unit.document,offset).start;
      if(oldOffset<unit.from||oldOffset>unit.to)continue;
      const id=row.parId!,cached=this.geometryUnits.get(id),analysis=cached?.unit.source===unit.source&&sameRows(cached.unit.rows,unit.rows)?cached.analysis:await this.analyzer.analyze(id,unit.rows,unit.source).catch(()=>null);
      if(!analysis||ticket!==this.sourceCursorTicket||!this.enabled)return;
      for(const char of analysis.characters){const from=unit.from+char.from,to=unit.from+char.to,distance=oldOffset<from?from-oldOffset:oldOffset>to?oldOffset-to:0;if(!best||distance<best.distance)best={char:{...char,x:char.x+(oldOffset>=to?char.w:0)},distance};}
      if(best)break search;
    }
    if(!best)return;
    this.options.container.querySelectorAll('.rtex-source-caret').forEach(node=>node.remove());
    const char=best.char,page=this.options.container.querySelector<HTMLElement>(`[data-page="${char.page}"]`);if(!page)return;
    const scale=Number(page.style.getPropertyValue('--scale-factor'))||1,highlight=document.createElement('div');highlight.className='rtex-source-caret';
    highlight.style.cssText=`left:${char.x*scale/SP_PER_BP}px;top:${char.y*scale/SP_PER_BP}px;height:${char.h*scale/SP_PER_BP}px;`;page.append(highlight);
    if(scroll)highlight.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    setTimeout(()=>highlight.remove(),2200);
  }

  private async receive(packet: any, session = this.session) {
    if (!this.enabled) return;
    if (packet.type === 'document-ack') {
      if (packet.revision) this.latestRevision = Math.max(this.latestRevision,packet.revision);
      if (this.inFlight === packet.sequence) { this.inFlight = null; if (packet.error) this.options.notify(packet.error,true); this.flushDocuments(); }
      return;
    }
    if (packet.type === 'state') { this.status(packet.message, packet.state === 'starting' ? 'busy' : 'off'); return; }
    if (packet.type === 'log') { this.options.log(packet.text); return; }
    if (packet.type === 'error') { this.status('实时引擎错误', 'error'); this.options.notify(packet.message, true); if (packet.fallback) this.options.fallback(packet.message); return; }
    if (packet.type === 'spans') {
      const first=!this.spans.has(packet.file),previous=new Map<number,string|undefined>();
      // A source snapshot does not change every page's pixels. Only a live unit
      // waiting for this binding needs its hit geometry rebuilt; other units
      // retain their exact source snapshot and can still rebase on click.
      if(!first)for(const span of packet.spans){const overlay=this.model.overlays.get(span.id);if(!overlay)continue;const old=this.bindings.resolve(span.id,overlay.revision);previous.set(span.id,old?.source.slice(old.from,old.to));}
      this.bindings.install(packet.file, packet.source, packet.spans, packet.revision);this.spans.set(packet.file,packet.spans);
      if(first){this.orphanCacheRevision=-1;for(const layer of this.hitLayers.values())layer.groups.delete(0);this.schedule();}
      else {const dirty=new Set<number>();for(const [id,old]of previous){const overlay=this.model.overlays.get(id)!;const next=this.bindings.resolve(id,overlay.revision);if(old!==next?.source.slice(next.from,next.to))for(const fragment of overlay.fragments)dirty.add(fragment.page);}if(dirty.size)this.schedule(dirty);}
      return;
    }
    if (packet.type === 'export') {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([await bytes(packet.data)], { type: 'application/pdf' })); a.download = packet.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); this.status('已完整导出 PDF', 'ready'); return;
    }
    if (packet.type === 'resources') {
      for (const [key, resource] of packet.fonts || []) this.fonts.add(key, resource.data ? { ...resource, data: await bytes(resource.data) } : resource);
      for (const [key, resource] of packet.images || []) this.images.add(key, resource.data ? { ...resource, data: await bytes(resource.data) } : resource);
      return;
    }
    if (packet.type !== 'engine-event') return;
    const e = packet.value;
    if (e.reply && e.result?.source_revision) this.latestRevision = Math.max(this.latestRevision, e.result.source_revision);
    if (e.event === 'LayoutUpdate') {
      if(e.versions.source_revision<this.layoutRevision)return;
      if (!e.pages_total || e.compile?.state !== 'Ok') { this.status('语法尚未完成 · 保留上次有效排版', 'error'); if (!this.model.hasLayout && this.latestRevision <= 1) this.options.fallback(e.convergence?.reasons?.join('\n') || '当前模板未通过 LuaLaTeX 实时排版'); return; }
      for (const page of e.pages_changed) this.layoutPages.set(page.page,page);
      for (const page of this.layoutPages.keys()) if (page > e.pages_total) this.layoutPages.delete(page);
      void this.installLayout({ ...packet, value: { ...e, pages_changed: [...this.layoutPages.values()] } }, session);
    } else if (e.event === 'ParagraphUpdate') {
      if (e.versions.source_revision <= this.layoutRevision || Math.max(this.model.overlays.get(e.par_id)?.revision||0,this.blockedOverlays.get(e.par_id)||0)>e.versions.source_revision) return;
      let dirty: Set<number>;
      if (e.status === 'removed') {this.blockedOverlays.delete(e.par_id);dirty = this.model.dropOverlays([e.par_id]);}
      else if (e.status === 'ok' || e.status === 'ok_degraded') {
        const candidate:Overlay={parId:e.par_id,dl:e.dl,fragments:e.fragments,revision:e.versions.source_revision},safety=this.safeOverlay(candidate);
        if(!safety.safe){
          dirty=this.model.dropOverlays([e.par_id]);this.blockedOverlays.set(e.par_id,e.versions.source_revision);
          for(const fragment of this.model.placements.get(e.par_id)||[])dirty.add(fragment.page);
          for(const page of dirty)this.rowCache.delete(page);this.rowsByUnit=null;
          this.status(safety.reason==='structured-content'?'图表正在完整重排 · 保留真实 PDF':'换行与分栏正在重排 · 可继续输入','busy');this.refreshUnsafeLayout();this.schedule(dirty);return;
        }
        this.blockedOverlays.delete(e.par_id);dirty = this.model.applyParagraph(e.par_id, e.dl, e.fragments, e.versions.source_revision);
      }
      else { this.status('当前段落等待后台编译', 'busy'); return; }
      for (const page of dirty) this.rowCache.delete(page); this.rowsByUnit = null;
      const ms = (e.timing.total_us / 1000).toFixed(1);
      const fallback = e.dl && inexactReason(e.dl, this.fonts, this.images);
      this.status(fallback ? '该区域等待完整排版，保留原 PDF' : `实时段落 ${ms} ms${e.pagination_stale ? ' · 分页待更新' : ''}`, fallback ? 'busy' : 'live'); this.schedule(dirty);
    } else if (e.event === 'BackgroundScheduled') this.status('该区域由后台完整排版更新', 'busy');
    else if (e.event === 'Diagnostics' && e.items?.some((d: any) => d.severity === 'error')) this.status('源码有错误 · 保留上次排版', 'error');
    else if (e.event === 'EngineState' && e.state === 'Starting') this.status('正在加载模板与字体…', 'busy');
  }
  private async installLayout(packet: any, session: number) {
    const ticket = ++this.layoutTicket, e = packet.value;
    void this.loadingPdf?.destroy().catch(() => {}); this.loadingPdf = null;
    let next: PDFDocumentProxy | null = null;
    try {
      if (packet.pdf) {
        const task = typeof packet.pdf === 'string'
          ? getDocument({ data: await bytes(packet.pdf), isEvalSupported: false })
          : getDocument({ url: `/__latex/realtime-pdf?generation=${packet.pdf.generation}&layout=${packet.pdf.layout}`, httpHeaders: { 'X-LaTeX-Token': this.options.token() }, isEvalSupported: false });
        this.loadingPdf = task; next = await task.promise;
      }
      if (!this.enabled || session !== this.session || ticket !== this.layoutTicket) { void next?.destroy(); return; }
      this.loadingPdf = null;
      this.model.applyLayout({ pages: e.pages_changed, pagesTotal: e.pages_total, placements: e.placements,
        keepFromRevision: this.latestRevision > e.versions.source_revision ? e.versions.source_revision + 1 : null });
      for(const [id,revision]of this.blockedOverlays)if(revision<=e.versions.source_revision)this.blockedOverlays.delete(id);
      const accepted:Overlay[]=[];
      for(const overlay of this.model.overlays.values()){
        if(this.safeOverlay(overlay,accepted).safe)accepted.push(overlay);
        else {this.model.dropOverlays([overlay.parId]);this.blockedOverlays.set(overlay.parId,overlay.revision);}
      }
      if(this.blockedOverlays.size)this.refreshUnsafeLayout();
      this.layoutRevision = e.versions.source_revision; this.rowCache.clear(); this.rowsByUnit = null;
      if (this.preservePdf) { this.options.container.replaceChildren(); this.preservePdf = false; }
      this.pageCount = e.pages_total; this.options.pages(this.pageCount); this.version++; this.bases.clear();
      const old = this.document; this.document = next; void old?.destroy().catch(() => {});
      this.status(this.pending.size || this.inFlight!==null || this.blockedOverlays.size || e.versions.source_revision < this.latestRevision ? '实时编辑可用 · 后台正在更新分页' : '实时预览 · 排版已同步', 'ready'); this.schedule();
    } catch (error) {
      if (this.enabled && ticket === this.layoutTicket && session === this.session) this.options.notify('后台 PDF 更新失败，保留当前可编辑页面。', true);
    }
  }
  private schedule(pages: Iterable<number> = this.model.pages.keys()) {
    if (!this.enabled) return;
    this.ensurePageShells();
    this.renderQueue.request(this.draggedBlock?[...pages].filter(page=>!this.dragFrozenPages.has(page)):pages);
  }
  private ensurePageShells() {
    if (this.shellsVersion === this.version) return; this.shellsVersion = this.version;
    for (const [number, page] of this.model.pages) {
      let element = this.options.container.querySelector<HTMLElement>(`[data-page="${number}"]`);
      if(element&&this.draggedBlock&&this.dragFrozenPages.has(number))continue;
      if (!element) {
        element = document.createElement('div'); element.className = 'pdf-page rtex-page'; element.dataset.page = String(number);
        const canvas = document.createElement('canvas'), layer = document.createElement('div'); layer.className = 'rtex-text-layer'; element.append(canvas, layer); this.options.container.append(element);
      }
      const width = (page.dl.page_width || page.dl.width) / SP_PER_BP, height = (page.dl.page_height || page.dl.height) / SP_PER_BP;
      const scale = this.zoom || Math.max(.28, Math.min(1.6, (this.options.viewport.clientWidth - 48) / width));
      element.style.width = width * scale + 'px'; element.style.height = height * scale + 'px'; element.style.setProperty('--scale-factor', String(scale));
    }
    for (const element of this.options.container.querySelectorAll<HTMLElement>('[data-page]')) if (Number(element.dataset.page) > this.pageCount&&!this.draggedBlock) element.remove();
  }
  private visiblePages() {
    const view = this.options.viewport.getBoundingClientRect();
    if (!view.width || !view.height) return [];
    return [...this.options.container.querySelectorAll<HTMLElement>('[data-page]')].filter(element => {
      const rect = element.getBoundingClientRect(); return nearViewport(rect.top, rect.bottom, view.top, view.bottom);
    }).map(element => Number(element.dataset.page));
  }
  private pageRows(page: number): { rows: Row[]; overlays: ReturnType<PreviewModel['overlaysOn']>; hidden: Set<number> } {
    const cached = this.rowCache.get(page); if (cached) return cached;
    const p = this.model.pages.get(page)!; const overlays = this.model.overlaysOn(page).filter(o => !inexactReason(o.overlay.dl, this.fonts, this.images, o.rows.map(r => r.line)));
    const hidden = new Set<number>(); for (const ov of overlays) for (const i of this.model.ownLines(page, ov.overlay.parId)) hidden.add(i);
    const owners = new Map<number, number>(); for (const id of this.model.placements.keys()) for (const i of this.model.ownLines(page, id)) owners.set(i, id);
    const rows: Row[] = p.dl.lines.flatMap((line, i) => hidden.has(i) ? [] : [{ dl: p.dl, line, dx: 0, dy: 0, parId: owners.get(i), page, revision: this.layoutRevision }]);
    for (const ov of overlays) for (const r of ov.rows) rows.push({ ...r, dl: ov.overlay.dl, parId: ov.overlay.parId, page, revision: ov.overlay.revision });
    const result = { rows, overlays, hidden }; this.rowCache.set(page, result); return result;
  }
  private async paintPage(pageNumber: number, current: () => boolean) {
    const version = this.version;
    const valid = () => current() && version === this.version && !(this.draggedBlock&&this.dragFrozenPages.has(pageNumber));
    if (!valid()) return;
    const page = this.model.pages.get(pageNumber); if (!page) return;
    const width = (page.dl.page_width || page.dl.width) / SP_PER_BP, height = (page.dl.page_height || page.dl.height) / SP_PER_BP;
    const scale = this.zoom || Math.max(.28, Math.min(1.6, (this.options.viewport.clientWidth - 48) / width));
    const dpr = Math.min(devicePixelRatio || 1, 2), deviceScale = scale * dpr;
    let element = this.options.container.querySelector<HTMLElement>(`[data-page="${pageNumber}"]`);
    if (!element) { element = document.createElement('div'); element.className = 'pdf-page rtex-page'; element.dataset.page = String(pageNumber); const c = document.createElement('canvas'); const t = document.createElement('div'); t.className = 'rtex-text-layer'; element.append(c, t); this.options.container.append(element); }
    element.style.width = width * scale + 'px'; element.style.height = height * scale + 'px'; element.style.setProperty('--scale-factor', String(scale));
    const canvas = element.querySelector('canvas')!,pixelWidth=Math.ceil(width*deviceScale),pixelHeight=Math.ceil(height*deviceScale);
    let base = this.bases.get(pageNumber);
    if (!base) {
      base = document.createElement('canvas'); base.width = pixelWidth; base.height = pixelHeight; const context = base.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, base.width, base.height);
      if (this.document && pageNumber <= this.document.numPages) {
        const pdfPage = await this.document.getPage(pageNumber); const viewport = pdfPage.getViewport({ scale });
        await pdfPage.render({ canvasContext: context, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
      } else {
        const painter = new Painter(context, [deviceScale / SP_PER_BP, 0, 0, deviceScale / SP_PER_BP, 0, 0], this.fonts, this.images);
        if (hasStructuredInk(page.dl) || inexactReason(page.dl, this.fonts, this.images)) { this.status('此页等待完整 PDF', 'busy'); return; }
        painter.draw(page.dl, page.dl.other || []); for (const line of page.dl.lines) painter.draw(page.dl, line.items);
      }
      if (!valid()) return;
      this.bases.set(pageNumber, base);
    }
    if (!valid()) return;
    if(canvas.width!==pixelWidth)canvas.width=pixelWidth;if(canvas.height!==pixelHeight)canvas.height=pixelHeight;canvas.style.width=width*scale+'px';canvas.style.height=height*scale+'px';
    const context = canvas.getContext('2d')!;
    const { rows, overlays } = this.pageRows(pageNumber);
    const painter = new Painter(context, [deviceScale / SP_PER_BP, 0, 0, deviceScale / SP_PER_BP, 0, 0], this.fonts, this.images);
    paintRasterFrame(context,base,canvas.width,canvas.height,()=>{
      for (const ov of overlays) {
        const old = [...this.model.ownLines(pageNumber, ov.overlay.parId)].map(i => ({ line: page.dl.lines[i], dx: 0, dy: 0 })); painter.clearLines(old, '#fff', 32768);
      }
      for(const ov of overlays){const overlayPainter=new Painter(context,[deviceScale/SP_PER_BP,0,0,deviceScale/SP_PER_BP,0,0],this.fonts,this.images);for(const row of ov.rows)overlayPainter.draw(ov.overlay.dl,row.line.items,row.dx,row.dy);}
    });
    await this.paintTextLayer(element.querySelector<HTMLElement>('.rtex-text-layer')!,rows,pageNumber,scale,valid);
  }
  private async paintTextLayer(layer:HTMLElement,rows:Row[],pageNumber:number,scale:number,valid:()=>boolean) {
    const previous=this.hitLayers.get(pageNumber), groups=new Map<number,Row[]>();
    for(const row of rows){const id=row.parId??0;let group=groups.get(id);if(!group)groups.set(id,group=[]);group.push(row);}
    const nextGroups=new Map<number,{rows:Row[];source:string;nodes:Node[]}>(),nodes:Node[]=[];
    for(const [id,pageRows] of groups){
      if(!valid())return;
      const row=pageRows[0],unit=this.unit(row),unitRows=unit?.rows||pageRows,source=unit?.source||'',old=previous?.groups.get(id);
      if(previous?.scale===scale&&old?.source===source&&sameRows(old.rows,unitRows)){
        nextGroups.set(id,old);nodes.push(...old.nodes);continue;
      }
      const groupNodes:Node[]=[],paragraphKeys=new Map<object,string>(),targets=new Map<string,BlockTarget>(),regionsByKey=new Map<string,HTMLElement>();
      let analysis:UnitAnalysis|null=null;
      if(unit)try{analysis=await this.analyzer.analyze(id,unitRows,source);}catch(error){if(isAnalysisCancelled(error))return;throw error;}
      if(!valid())return;
      if(unit&&analysis)for(const fragment of analysis.paragraphs){
        if(fragment.page!==pageNumber)continue;
        const key=unit.file+':'+(unit.from+fragment.target.from),region=document.createElement('div'),r=fragment.rect;
        region.className='rtex-paragraph-hit';region.dataset.blockKey=key;region.title='点击直接编辑 · Alt+双击编辑 LaTeX 源码';
        region.style.cssText=`left:${r.x*scale/SP_PER_BP-3}px;top:${r.y*scale/SP_PER_BP-3}px;width:${r.w*scale/SP_PER_BP+6}px;height:${r.h*scale/SP_PER_BP+6}px;`;
        const target=this.bindTarget({...fragment.target,file:unit.file,from:unit.from+fragment.target.from,to:unit.from+fragment.target.to},unit.document);
        targets.set(key,target);regionsByKey.set(key,region);
        this.nodeTargets.set(region,target);
        region.onpointerdown=event=>this.beginPageEdit(event,layer,pageNumber,scale,target,id);
        region.ondblclick=event=>{if(event.altKey){event.preventDefault();event.stopPropagation();this.openBlock(target,region.getBoundingClientRect(),id);}};
        for(const index of fragment.rows)paragraphKeys.set(unit.rows[index].line,key);groupNodes.push(region);
        if(target.kind==='paragraph'){
          const grip=document.createElement('button');grip.className='rtex-paragraph-grip';grip.textContent='⠿';grip.draggable=true;grip.dataset.blockKey=key;grip.title='拖动段落排序';grip.setAttribute('aria-label','拖动段落排序');
          grip.style.cssText=`left:${r.x*scale/SP_PER_BP-19}px;top:${r.y*scale/SP_PER_BP-3}px;`;this.nodeTargets.set(grip,target);
          grip.ondragstart=event=>{if(!this.startBlockDrag(target,event))event.preventDefault();};
          grip.ondragend=()=>this.clearBlockDrag();groupNodes.push(grip);
        }
      }
      for(const row of pageRows)for(const word of words([row])){
        const span=document.createElement('span');span.textContent=word.text;span.dataset.blockKey=paragraphKeys.get(row.line)||'';
        span.style.cssText=`position:absolute;left:${word.x*scale/SP_PER_BP}px;top:${(word.y-word.size*.8)*scale/SP_PER_BP}px;width:${Math.max(word.w*scale/SP_PER_BP,2)}px;height:${word.size*1.2*scale/SP_PER_BP}px;font-size:${word.size*scale/SP_PER_BP}px;line-height:1;`;
        span.title='点击直接编辑 · 拖动选择文字 · Alt+双击编辑源码';
        const directTarget=targets.get(span.dataset.blockKey!);
        if(directTarget)this.nodeTargets.set(span,directTarget);
        if(directTarget)span.onpointerdown=event=>this.beginPageEdit(event,layer,pageNumber,scale,directTarget,id);
        span.ondblclick=event=>{
          if(!this.options.editing()&&!event.ctrlKey&&!event.metaKey)return;
          event.preventDefault();event.stopPropagation();window.getSelection()?.removeAllRanges();
          const key=span.dataset.blockKey!,paragraph=regionsByKey.get(key),target=targets.get(key),anchor=(paragraph||span).getBoundingClientRect();
          if(target&&!event.altKey&&!event.ctrlKey&&!event.metaKey)return;
          if(target&&event.altKey)this.openBlock(target,anchor,id);
          else this.openParagraph(row,anchor,word,false,event.ctrlKey||event.metaKey);
        };groupNodes.push(span);
      }
      if(unit&&analysis){
        const formulas=mathRegions(source);
        for(const hit of analysis.math)for(const box of hit.boxes){
          if(box.page!==pageNumber)continue;
          const formula=formulaTarget(source,formulas[hit.index]);if(!formula)continue;
          const target=this.bindTarget({...formula,file:unit.file,from:unit.from+formula.from,to:unit.from+formula.to},unit.document),element=document.createElement('div');
          element.className='rtex-math-hit';element.setAttribute('role','button');element.setAttribute('aria-label','编辑公式');element.tabIndex=0;element.title='点击在页面内编辑公式 · Alt+双击编辑源码';
          const containing=[...targets.values()].find(block=>block.from<=unit.from+formulas[hit.index].from&&block.to>=unit.from+formulas[hit.index].to);
          if(containing){element.dataset.blockKey=containing.file+':'+containing.from;this.nodeTargets.set(element,containing);}
          element.style.cssText=`left:${box.x*scale/SP_PER_BP-2}px;top:${box.y*scale/SP_PER_BP-2}px;width:${box.w*scale/SP_PER_BP+4}px;height:${box.h*scale/SP_PER_BP+4}px;`;
          const open=()=>{if(this.options.editing()&&this.enabled){window.getSelection()?.removeAllRanges();this.openDirect(target,id);}};
          element.onpointerdown=event=>{if(event.button===0&&!event.altKey&&this.options.editing()){event.preventDefault();event.stopPropagation();open();}};
          element.ondblclick=event=>{event.preventDefault();event.stopPropagation();if(event.altKey)this.openBlock(target,element.getBoundingClientRect(),id);};
          element.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}};groupNodes.push(element);
        }
        for(const object of analysis.objects){
          if(object.page!==pageNumber)continue;
          const target=this.bindTarget({...object.target,file:unit.file,from:unit.from+object.target.from,to:unit.from+object.target.to},unit.document),hit=document.createElement('div');
          hit.className='rtex-object-hit';hit.tabIndex=0;hit.draggable=true;hit.setAttribute('role','button');hit.setAttribute('aria-label',object.kind==='image'?'调整图片':'调整表格');hit.title='拖动图表换位置；单击后拖四角或边中点缩放';
          hit.dataset.blockKey=target.file+':'+target.from;this.nodeTargets.set(hit,target);
          hit.style.cssText=`left:${object.x*scale/SP_PER_BP}px;top:${object.y*scale/SP_PER_BP}px;width:${object.w*scale/SP_PER_BP}px;height:${object.h*scale/SP_PER_BP}px;`;
          const open=()=>{if(this.options.editing())this.openObject(target,id,object);};
          hit.onpointerdown=event=>{if(event.button!==0||event.altKey||!this.options.editing())return;event.stopPropagation();open();};
          hit.ondragstart=event=>{open();if(this.object)this.object.startMove(event);else event.preventDefault();};hit.ondragend=()=>{this.object?.endMove();this.clearBlockDrag();};
          hit.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}};
          hit.ondblclick=event=>{if(event.altKey){event.preventDefault();event.stopPropagation();this.openBlock(target,hit.getBoundingClientRect(),id);}};groupNodes.push(hit);
        }
      }
      if(id===0)for(const item of this.orphanObjects()){
        if(item.region.page!==pageNumber)continue;
        const object=item.region,hit=document.createElement('div');hit.className='rtex-object-hit';hit.tabIndex=0;hit.draggable=true;hit.setAttribute('role','button');hit.setAttribute('aria-label','调整图片');hit.title='单击后拖四角或边中点缩放；特殊标题图片绑定标题布局';hit.dataset.blockKey=item.target.file+':'+item.target.from;this.nodeTargets.set(hit,item.target);
        hit.style.cssText=`left:${object.x*scale/SP_PER_BP}px;top:${object.y*scale/SP_PER_BP}px;width:${object.w*scale/SP_PER_BP}px;height:${object.h*scale/SP_PER_BP}px;`;
        hit.onpointerdown=event=>{if(event.button!==0||!this.options.editing())return;event.stopPropagation();this.openObject(item.target,-1,object);};
        hit.ondragstart=event=>{if(!this.options.editing()){event.preventDefault();return;}this.openObject(item.target,-1,object);if(this.object)this.object.startMove(event);else event.preventDefault();};hit.ondragend=()=>{this.object?.endMove();this.clearBlockDrag();};groupNodes.push(hit);
      }
      if(unit&&analysis){this.geometryUnits.set(id,{unit,analysis});this.refreshPageEditor(id);this.refreshObjectEditor(id);}
      nextGroups.set(id,{rows:unitRows,source,nodes:groupNodes});nodes.push(...groupNodes);
      // Keep pointer/input events responsive even when a large unit is first exposed.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(!valid())return;
    // Preserve unchanged nodes: a background update cannot remove the first click
    // of a double-click or rebuild every word while another paragraph is edited.
    reconcileNodes(layer,nodes);
    this.hitLayers.set(pageNumber,{scale,groups:nextGroups});
    if(this.objectOrigin?.unit===-1)this.refreshOrphanObject();
    layer.querySelectorAll<HTMLElement>('.rtex-paragraph-hit').forEach(region=>region.classList.toggle('active',region.dataset.blockKey===this.activeSource?.file+':'+this.activeSource?.from));
    let hoverKey:string|undefined;
    const hover=(key?:string)=>{if(key===hoverKey)return;hoverKey=key;layer.querySelectorAll<HTMLElement>('.rtex-paragraph-hit,.rtex-paragraph-grip').forEach(region=>region.classList.toggle('hover',!!key&&region.dataset.blockKey===key));};
    layer.onpointermove=event=>hover((event.target as HTMLElement).closest<HTMLElement>('[data-block-key]')?.dataset.blockKey);
    layer.onpointerleave=()=>hover();
  }
  private startBlockDrag(target:BlockTarget,event:DragEvent,keepObject=false){
    if(!this.options.editing()||!event.dataTransfer)return false;
    if(keepObject){this.direct?.close();this.block?.close();this.inline?.close();}else this.closeEditor();
    try{
      const file=this.options.files().find(f=>f.name===target.file);if(!file)return false;
      const current=rebaseTarget(target,this.targetSources.get(target)||file.content,file.content);if(!current)throw Error('内容已改变，请重新选择后拖动。');
      const block=objectMoveTarget(file,current);this.dragFrozenPages=new Set(this.hitLayers.keys());this.draggedBlock={target:block,document:file.content};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',block.text.slice(0,120));this.options.container.classList.add('rtex-dragging');return true;
    }catch(error){this.options.notify((error as Error).message,true);return false;}
  }
  private dropTarget(event:DragEvent){
    const element=(event.target as HTMLElement).closest<HTMLElement>('[data-block-key]'),target=element&&this.nodeTargets.get(element);if(!element||!target)return null;
    const region=element.classList.contains('rtex-object-hit')||element.classList.contains('rtex-object-editor')?element:[...this.options.container.querySelectorAll<HTMLElement>('.rtex-paragraph-hit,.rtex-object-hit')].find(node=>node.dataset.blockKey===element.dataset.blockKey);
    return region?{target,region}:null;
  }
  private dragOver(event:DragEvent){
    if(!this.draggedBlock||!this.options.editing())return;
    const viewport=this.options.viewport.getBoundingClientRect();if(event.clientY<viewport.top+42)this.options.viewport.scrollTop-=22;else if(event.clientY>viewport.bottom-42)this.options.viewport.scrollTop+=22;
    const drop=this.dropTarget(event);if(!drop||!['paragraph','source'].includes(drop.target.kind))return;
    event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';
    this.options.container.querySelectorAll('.rtex-drop-before,.rtex-drop-after').forEach(node=>node.classList.remove('rtex-drop-before','rtex-drop-after'));
    const rect=drop.region.getBoundingClientRect();drop.region.classList.add(event.clientY<rect.top+rect.height/2?'rtex-drop-before':'rtex-drop-after');
  }
  private dropBlock(event:DragEvent){
    const drag=this.draggedBlock,drop=this.dropTarget(event);if(!drag||!drop)return;
    event.preventDefault();event.stopPropagation();const rect=drop.region.getBoundingClientRect(),after=event.clientY>=rect.top+rect.height/2;
    try{
      this.object?.close();const files=this.options.files(),a=files.find(f=>f.name===drag.target.file),b=files.find(f=>f.name===drop.target.file);if(!a||!b)return;
      const source=rebaseTarget(drag.target,drag.document,a.content),target=rebaseTarget(drop.target,this.targetSources.get(drop.target)||b.content,b.content);if(!source||!target)throw Error('内容边界已改变，请重新拖动。');
      const changes=source.kind==='paragraph'&&target.kind==='paragraph'?moveParagraph(files,source,target,after):moveObject(files,source,target,after,{placement:'near'});if(!changes.length)return;
      if(!this.options.editFiles?.(changes))throw Error('项目内容已改变，移动未执行。');this.requestLayout();this.options.notify(source.kind==='source'?'已移动整张图表，正在按模板确认浮动位置；可撤销移动。':'已调整源码顺序，正在重新分页；可撤销移动。');
    }catch(error){this.options.notify((error as Error).message,true);}finally{this.clearBlockDrag();}
  }
  private clearBlockDrag(){const wasDragging=!!this.draggedBlock;this.draggedBlock=null;this.dragFrozenPages.clear();this.options.container.classList.remove('rtex-dragging');this.options.container.querySelectorAll('.rtex-drop-before,.rtex-drop-after').forEach(node=>node.classList.remove('rtex-drop-before','rtex-drop-after'));if(wasDragging){this.shellsVersion=-1;this.schedule();}}
  private orphanObjects(){
    if(this.orphanCacheRevision===this.layoutRevision)return this.orphanObjectCache;
    this.orphanCacheRevision=this.layoutRevision;this.orphanObjectCache=[];
    const files=this.options.files(),owned=new Set<string>(),seen=new Set<number>(),orphanRows:Row[]=[];
    for(const page of this.model.pages.keys())for(const row of this.pageRows(page).rows){
      if(row.parId===undefined){orphanRows.push(row);continue;}if(seen.has(row.parId))continue;seen.add(row.parId);
      const unit=this.unit(row),file=unit&&files.find(f=>f.name===unit.file);if(!unit||!file)continue;
      for(const command of graphics(unit.source)){
        const target=rebaseTarget({...command,file:unit.file,from:unit.from+command.from,to:unit.from+command.to,kind:'source',mode:'latex',label:'图片'},unit.document,file.content);
        if(target)owned.add(unit.file+':'+target.from);
      }
    }
    const normalized=(name:string)=>name.replaceAll('\\','/').replace(/^\.\//,'').replace(/\.[A-Za-z0-9]+$/,'').toLowerCase();
    const rendered=[...new Set([...this.model.pages.values()].flatMap(page=>Object.values(page.dl.images_info||{}).map(info=>normalized(info.file))))];
    const candidates=files.filter(f=>f.name.endsWith('.tex')).flatMap(file=>graphics(file.content).filter(command=>{
      const name=normalized(command.path);
      return !/[\\#{}]/.test(command.path)&&!owned.has(file.name+':'+command.from)&&rendered.some(path=>path===name||path.endsWith('/'+name));
    }).map(command=>({file,command}))),boxes=imageRectangles(orphanRows);
    // A single unowned source image and a single unowned page box form a unique
    // mapping (e.g. a teaser injected into a title macro). Never guess an order.
    if(candidates.length===1&&boxes.length===1){
      const {file,command}=candidates[0],target=this.bindTarget({file:file.name,from:command.from,to:command.to,text:command.text,kind:'source',mode:'latex',label:'图片'},file.content);
      this.orphanObjectCache.push({target,region:{...boxes[0],kind:'image',target}});
    }
    return this.orphanObjectCache;
  }
  private refreshOrphanObject(){
    if(!this.object||!this.objectOrigin||this.layoutRevision<this.latestRevision||this.inFlight!==null||this.pending.size)return;
    const origin=this.objectOrigin,file=this.options.files().find(f=>f.name===origin.target.file);if(!file)return;
    const target=rebaseTarget(origin.target,origin.document,file.content),item=this.orphanObjects().find(o=>o.target.file===target?.file&&o.target.from===target?.from);if(!item||!target)return;
    const page=this.options.container.querySelector<HTMLElement>(`[data-page="${item.region.page}"]`);this.object.refresh(item.region,target.text,page||undefined);
  }
  private openObject(target:BlockTarget,id:number,region:ObjectRegion){
    const current=this.options.files().find(f=>f.name===target.file);if(!current)return;
    const rebased=rebaseTarget(target,this.targetSources.get(target)||current.content,current.content);if(!rebased)return;
    if(this.object?.target.file===rebased.file&&this.object.target.from===rebased.from)return;
    const page=this.options.container.querySelector<HTMLElement>(`[data-page="${region.page}"]`);if(!page)return;
    this.bindTarget(rebased,current.content);let moveReason='';try{objectMoveTarget(current,rebased);}catch(error){moveReason=(error as Error).message;}
    this.options.beforeEdit?.();this.closeEditor();this.objectOrigin={target:rebased,document:current.content,unit:id};
    this.object=new PageObjectEditor({target:rebased,region,page,
      moveReason,moveStart:event=>this.startBlockDrag(rebased,event,true),moveEnd:()=>this.clearBlockDrag(),
      graphicx:()=>/\\(?:resizebox|scalebox)\b/.test(region.target.text)||[...this.model.pages.values()].some(page=>Object.keys(page.dl.images_info||{}).length>0)||sourceSupportsGraphics(this.options.files(),this.options.main()),
      edit:(from,to,expected,replacement)=>{const result=this.options.edit(rebased.file,from,to,expected,replacement);if(result)this.requestLayout();return result;},boundary:()=>this.options.editBoundary(rebased.file),
      notify:message=>this.options.notify(message,true),jump:()=>this.options.jump(rebased.file,rebased.from),close:()=>{this.object=null;this.objectOrigin=null;this.flushDocuments();}});
    this.nodeTargets.set(this.object.element,rebased);
  }
  private refreshObjectEditor(id:number){
    const origin=this.objectOrigin,editor=this.object;if(!origin||!editor||origin.unit===-1)return;
    const entry=this.geometryUnits.get(id);if(!entry||entry.unit.file!==origin.target.file)return;
    const target=rebaseTarget(origin.target,origin.document,entry.unit.document);if(!target)return;
    const region=entry.analysis.objects.find(o=>o.target.from+entry.unit.from===target.from);if(!region)return;origin.unit=id;
    const page=this.options.container.querySelector<HTMLElement>(`[data-page="${region.page}"]`);editor.refresh(region,target.text,page||undefined);
  }
  private status(text: string, kind: 'busy' | 'live' | 'ready' | 'error' | 'off') {
    this.options.status(text, kind); this.block?.updateStatus(text, kind === 'error');
  }
  private unit(row: Row) {
    if (row.parId === undefined) return null;
    const binding = this.bindings.resolve(row.parId, row.revision); if (!binding) return null;
    if (!this.rowsByUnit) {
      this.rowsByUnit = new Map();
      for (const page of this.model.pages.keys()) for (const r of this.pageRows(page).rows) if (r.parId !== undefined) {
        let group = this.rowsByUnit.get(r.parId); if (!group) this.rowsByUnit.set(r.parId, group = []); group.push(r);
      }
    }
    const rows = this.rowsByUnit.get(row.parId) || [];
    return { file: binding.file, from: binding.from, to: binding.to, source: binding.source.slice(binding.from,binding.to), document: binding.source, rows };
  }
  private bindTarget(target: BlockTarget, source: string) { this.targetSources.set(target,source); return target; }
  private beginPageEdit(event: PointerEvent, layer: HTMLElement, page: number, scale: number, target: BlockTarget, id: number) {
    if(event.button!==0||event.altKey||event.ctrlKey||event.metaKey||!this.options.editing()||target.kind==='source')return;
    event.preventDefault();event.stopPropagation();window.getSelection()?.removeAllRanges();
    this.openDirect(target,id);this.direct?.drag(event,layer,page,scale);
  }
  private openDirect(target: BlockTarget, id: number) {
    const current=this.options.files().find(f=>f.name===target.file);if(!current)return;
    const original=this.targetSources.get(target)||current.content,rebased=rebaseTarget(target,original,current.content);if(!rebased)return;
    if(this.direct&&this.direct.target.file===rebased.file&&this.direct.target.from===rebased.from&&this.direct.target.kind===rebased.kind)return;
    this.options.beforeEdit?.();this.closeEditor();
    this.activeUnit=id;this.activeSource={file:rebased.file,from:rebased.from};this.directOrigin={target:rebased,document:current.content};
    this.direct=new PageEditor({target:rebased,container:this.options.container,
      edit:(from,to,expected,replacement)=>this.options.edit(rebased.file,from,to,expected,replacement),
      boundary:()=>this.options.editBoundary(rebased.file),notify:message=>this.options.notify(message),
      cursor:(from,to)=>this.options.cursor?.(rebased.file,from,to),
      close:()=>{this.direct=null;this.directOrigin=null;this.activeUnit=null;this.activeSource=null;this.flushDocuments();this.schedule();}});
    this.refreshPageEditor(id);this.schedule();
  }
  private refreshPageEditor(id: number) {
    if(!this.direct||this.activeUnit!==id||!this.directOrigin)return;
    const entry=this.geometryUnits.get(id);if(!entry)return;
    const {unit,analysis}=entry,origin=this.directOrigin;
    const target=rebaseTarget(origin.target,origin.document,unit.document);if(!target)return;
    const from=target.from-unit.from,to=target.to-unit.from,p=visualText(target.text);
    const characters=analysis.characters.filter(g=>g.from>=from&&g.to<=to&&(target.kind==='formula'||p.chars.some(ch=>!ch.atom&&ch.from<=g.from-from&&ch.to>=g.to-from))).map(g=>({...g,from:g.from-from,to:g.to-from}));
    const formulas=mathRegions(unit.source);
    for(const hit of analysis.math){
      const region=formulas[hit.index];if(!region)continue;
      if(target.kind==='formula'){
        if(region.bodyFrom>from||region.bodyTo<to)continue;
        for(const box of hit.boxes)characters.push({...box,from:0,to:target.text.length});
      }else if(region.from>=from&&region.to<=to){
        for(const box of hit.boxes)characters.push({...box,from:region.from-from,to:region.to-from});
      }
    }
    this.direct.updateGeometry(target.text,characters);
  }
  private openParagraph(row: Row, anchor: DOMRect, clicked?: Word, wordOnly = false, jumpOnly = false) {
    if (!this.enabled) return this.options.notify('实时预览已停止，请重新开启。');
    const unit = this.unit(row);
    if (!unit) {
      const targets=pdfEditTargets(glyphTextOf([row]).text,this.options.files());
      if(targets.length===1)return this.openTarget(targets[0],anchor);
      return this.options.notify('此区域暂未找到唯一源码，请使用源码定位。');
    }
    const gt = glyphTextOf(unit.rows); const candidates = clicked ? [clicked] : words([row]);
    let mapped: ReturnType<typeof mapPlainWord> = null;
    for (const word of candidates) {
      const rowIndex = unit.rows.findIndex(r => r.page === row.page && r.line === row.line);
      const glyph = gt.glyphs.find(g => g.row === rowIndex && Math.abs(g.x - word.x) < 32 && Math.abs(g.y - word.y) < 32);
      if (glyph) mapped = mapPlainWord(gt, glyph.start, word.text, unit.source); if (mapped) break;
    }
    if (jumpOnly) return this.options.jump(unit.file, unit.from + (mapped?.from || 0));
    if (wordOnly && mapped) {
      const temporary = document.createElement('span'); temporary.style.cssText = `position:fixed;left:${anchor.left}px;top:${anchor.top}px;width:${anchor.width}px;height:${anchor.height}px;font-size:13px`; document.body.append(temporary);
      this.openInline(temporary, { file: unit.file, from: unit.from + mapped.from, to: unit.from + mapped.to, text: mapped.text }); temporary.remove(); return;
    }
    const relative = mapped ? paragraphTarget(unit.source, mapped.from) : { from: 0, to: unit.source.length, text: unit.source, kind: 'source' as const, mode: 'latex' as const, label: '块 · LaTeX' };
    if (!relative) return;
    const target = this.bindTarget({ ...relative, file: unit.file, from: unit.from + relative.from, to: unit.from + relative.to }, unit.document);
    this.openBlock(target, anchor, row.parId!);
    if (mapped && target.mode === 'text') this.block?.setSelection(mapped.from - relative.from, mapped.to - relative.from);
  }
  private openBlock(target: BlockTarget, anchor: DOMRect, unitId: number) {
    this.options.beforeEdit?.(); this.object?.close(); this.direct?.close(); this.inline?.close(); this.block?.close();
    const current = this.options.files().find(f => f.name === target.file); if (!current) return;
    const rebased = rebaseTarget(target, this.targetSources.get(target) || current.content, current.content);
    if (!rebased) { this.options.jump(target.file,Math.min(target.from,current.content.length)); this.options.notify('该段边界已在源码中改变，已定位到源码。'); return; }
    target = rebased;
    this.activeUnit = unitId; this.activeSource = { file: target.file, from: target.from };
    this.block = new PageBlockEditor({ target, anchor, viewport: this.options.viewport,
      edit: (from, to, expected, replacement) => this.options.edit(target.file, from, to, expected, replacement),
      boundary: () => this.options.editBoundary(target.file),
      close: () => { this.block = null; this.activeUnit = null; this.activeSource = null; this.flushDocuments(); this.schedule(); },
      jump: offset => this.options.jump(target.file, offset),
      formula: next => this.openBlock(next, anchor, unitId)
    }); this.schedule();
  }
  private openInline(anchor: HTMLElement, target: { file: string; from: number; to: number; text: string }) {
    this.block?.close();
    this.inline?.close(); this.options.editBoundary(target.file);
    const rect = anchor.getBoundingClientRect(), fontSize = getComputedStyle(anchor).fontSize; const input = document.createElement('input'); input.className = 'rtex-inline-editor'; input.value = target.text; input.setAttribute('aria-label', '在排版页面编辑文字');
    input.style.cssText = `position:fixed;left:${rect.left - 4}px;top:${rect.top - 4}px;min-width:${Math.max(rect.width + 24, 90)}px;font-size:${fontSize};z-index:65;`;
    input.title = `${target.file} · 输入实时回写 TeX；Enter 完成，Esc 撤销本次修改`;
    let current = target.text, closed = false;
    const close = (revert = false) => {
      if (closed) return; closed = true;
      if (revert && current !== target.text) this.options.edit(target.file, target.from, target.from + current.length, current, target.text);
      this.options.editBoundary(target.file); input.remove(); this.inline = null;
    };
    this.inline = { input, close }; document.body.append(input); input.focus(); input.select();
    input.oninput = () => {
      const replacement = escapeLatexText(input.value);
      if (this.options.edit(target.file, target.from, target.from + current.length, current, replacement)) { current = replacement; input.style.width = Math.max(rect.width + 24, input.value.length * parseFloat(fontSize) * .65 + 20, 90) + 'px'; }
      else { close(); this.options.notify('源码位置发生变化，已结束页面编辑。', true); }
    };
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); close(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } };
    input.onblur = () => close();
  }
}
