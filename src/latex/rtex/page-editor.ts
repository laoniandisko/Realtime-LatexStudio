import type { BlockTarget } from './block-edit';
import type { PageCharacter } from './page-geometry';
import { OBJECT, replaceVisual, changeAtSelection, textChange, visualOffset, visualSourceOffset, visualText } from './visual-text';
import { SP_PER_BP } from './vendor/protocol';

interface Options {
  target: BlockTarget; container: HTMLElement;
  edit(from: number, to: number, expected: string, replacement: string): boolean;
  boundary(): void; close(): void; notify(message: string): void;
  cursor?(from: number, to: number): void;
}
interface State { source: string; start: number; end: number }

/** Native keyboard/IME input with a caret drawn over the actual typeset glyphs.
 * The input is outside the replaceable hit layer, so reflow cannot steal focus. */
export class PageEditor {
  readonly input = document.createElement('textarea');
  current: string;
  readonly target: BlockTarget;
  private projection;
  private snapshot: string;
  private geometry: PageCharacter[] = [];
  private layers = new Map<number, HTMLElement>();
  private compositionPreview: HTMLElement | null = null;
  private composing = false;
  private closed = false;
  private closing = false;
  private history: State[] = [];
  private redo: State[] = [];
  private selection: { start: number; end: number } = { start: 0, end: 0 };
  private inputType = '';
  private lastCursor = '';
  private dragging: { layer: HTMLElement; anchor: number; move: (event: PointerEvent) => void; up: (event: PointerEvent) => void } | null = null;
  private readonly outside = (event: PointerEvent) => {
    const node = event.target as HTMLElement;
    if (node === this.input || node.closest?.('.rtex-text-layer')) return;
    this.close();
  };
  private readonly reposition = () => this.paint();

  constructor(private options: Options) {
    this.target = options.target; this.snapshot = this.current = this.target.text;
    this.projection = visualText(this.current);
    const input = this.input;
    input.className = this.target.kind === 'formula' ? 'rtex-page-input rtex-page-formula-input' : 'rtex-page-input';
    input.value = this.buffer(); input.spellcheck = false; input.autocomplete = 'off'; input.wrap = 'off';
    input.setAttribute('aria-label', this.target.kind === 'formula' ? '页面内公式 LaTeX' : '直接编辑排版正文');
    input.setAttribute('autocapitalize', 'off');
    options.boundary(); document.body.append(input);
    input.addEventListener('compositionstart', () => { this.composing = true; this.selection = { start: input.selectionStart, end: input.selectionEnd }; this.inputType = 'insertCompositionText'; });
    input.addEventListener('compositionend', () => { this.composing = false; this.commit(); });
    input.oninput = () => { if (!this.composing) this.commit(); else this.paint(); };
    input.onselect = input.onkeyup = () => this.paint();
    input.onkeydown = event => {
      if (event.isComposing || this.composing || event.keyCode === 229) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); this.restore(event.key.toLowerCase() === 'y' || event.shiftKey); return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      if (mod && event.key === 'Enter') { event.preventDefault(); this.close(); return; }
      if (this.target.kind !== 'formula' && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && !mod) {
        if (this.navigate(event.key, event.shiftKey)) event.preventDefault();
      }
    };
    input.onbeforeinput = event => {
      if (!this.composing) { this.selection = { start: input.selectionStart, end: input.selectionEnd }; this.inputType = event.inputType; }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); this.restore(event.inputType === 'historyRedo'); }
    };
    input.oncopy = event => this.copy(event, false);
    input.oncut = event => this.copy(event, true);
    input.onpaste = event => {
      if (!event.clipboardData || this.composing) return;
      event.preventDefault(); this.selection = { start: input.selectionStart, end: input.selectionEnd }; this.inputType = 'insertFromPaste';
      input.setRangeText(event.clipboardData.getData('text/plain').replaceAll(OBJECT, ''), input.selectionStart, input.selectionEnd, 'end'); this.commit();
    };
    document.addEventListener('pointerdown', this.outside);
    window.addEventListener('scroll', this.reposition, true); window.addEventListener('resize', this.reposition);
    input.focus({ preventScroll: true }); input.setSelectionRange(0, 0);
  }

  private buffer() { return this.target.kind === 'formula' ? this.current : this.projection.text; }
  updateGeometry(snapshot: string, geometry: PageCharacter[]) {
    if (this.closed) return;
    this.snapshot = snapshot; this.geometry = geometry; this.paint();
  }
  private positions() {
    const change = textChange(this.snapshot, this.current), delta = change.inserted.length - (change.to - change.from);
    const point = (offset: number) => {
      const rebased = offset <= change.from ? offset : offset >= change.to ? offset + delta : change.from + change.inserted.length;
      return this.target.kind === 'formula' ? rebased : visualOffset(this.projection, rebased);
    };
    return this.geometry.map(g => ({ ...g, start: point(g.from), end: point(g.to) }));
  }
  private nearest(page: number, x: number, y: number) {
    let best: ReturnType<PageEditor['positions']>[number] | undefined, score = Infinity;
    for (const g of this.positions()) {
      if (g.page !== page) continue;
      const dy = Math.max(g.y - y, 0, y - g.y - g.h), dx = Math.max(g.x - x, 0, x - g.x - g.w);
      const distance = dy * 1000 + dx;
      if (distance < score) { best = g; score = distance; }
    }
    if (!best) return undefined;
    return x > best.x + best.w / 2 ? best.end : best.start;
  }
  place(page: number, x: number, y: number, extend = false, word = false) {
    const index = this.nearest(page, x, y); if (index === undefined) return false;
    const anchor = this.input.selectionDirection === 'backward' ? this.input.selectionEnd : this.input.selectionStart;
    let start = extend ? Math.min(anchor, index) : index, end = extend ? Math.max(anchor, index) : index;
    if (word) {
      const value = this.input.value;
      while (start > 0 && /[\p{L}\p{N}_]/u.test(value[start - 1])) start--;
      while (end < value.length && /[\p{L}\p{N}_]/u.test(value[end])) end++;
    }
    this.input.focus({ preventScroll: true }); this.input.setSelectionRange(start, end);
    this.selection = { start, end }; this.paint(); return true;
  }
  drag(event: PointerEvent, layer: HTMLElement, page: number, scale: number) {
    this.stopDrag();
    const rect = layer.getBoundingClientRect();
    if (!this.place(page, (event.clientX - rect.left) * SP_PER_BP / scale, (event.clientY - rect.top) * SP_PER_BP / scale, event.shiftKey, event.detail >= 2)) return;
    if (event.detail >= 2) return;
    const anchor = this.input.selectionStart;
    const move = (e: PointerEvent) => {
      const r = layer.getBoundingClientRect(), index = this.nearest(page, (e.clientX - r.left) * SP_PER_BP / scale, (e.clientY - r.top) * SP_PER_BP / scale);
      if (index === undefined) return;
      this.input.setSelectionRange(Math.min(anchor, index), Math.max(anchor, index), index < anchor ? 'backward' : 'forward'); this.paint();
    };
    const up = () => { this.stopDrag(); this.selection = { start: this.input.selectionStart, end: this.input.selectionEnd }; };
    this.dragging = { layer, anchor, move, up }; layer.setPointerCapture(event.pointerId);
    layer.addEventListener('pointermove', move); layer.addEventListener('pointerup', up); layer.addEventListener('pointercancel', up);
  }
  private stopDrag() {
    const drag = this.dragging; if (!drag) return;
    drag.layer.removeEventListener('pointermove', drag.move); drag.layer.removeEventListener('pointerup', drag.up); drag.layer.removeEventListener('pointercancel', drag.up); this.dragging = null;
  }
  private state(): State { return { source: this.current, ...this.selection }; }
  private commit() {
    if (this.closed) return;
    const previous = this.buffer(), change = changeAtSelection(previous, this.input.value, this.selection.start, this.selection.end, this.inputType);
    if (previous === this.input.value) return;
    const state = this.state(), caret = this.input.selectionStart;
    const next = this.target.kind === 'formula' ? this.input.value : replaceVisual(this.current, change.from, change.to, change.inserted);
    if (!this.write(next)) return;
    this.history.push(state); if (this.history.length > 200) this.history.shift(); this.redo = [];
    // Special characters were escaped in TeX, not in the user's visible buffer.
    this.input.value = this.buffer(); this.input.setSelectionRange(Math.min(caret, this.input.value.length), Math.min(caret, this.input.value.length));
    this.selection = { start: this.input.selectionStart, end: this.input.selectionEnd }; this.paint();
  }
  private write(next: string) {
    if (!this.options.edit(this.target.from, this.target.from + this.current.length, this.current, next)) {
      this.options.notify('源码已在其他位置修改，已结束本段编辑。'); this.input.value = this.buffer(); this.close(); return false;
    }
    this.current = next; this.projection = visualText(next); return true;
  }
  private restore(forward: boolean) {
    const source = forward ? this.redo : this.history, destination = forward ? this.history : this.redo;
    const state = source.pop(); if (!state) return;
    const before = { source: this.current, start: this.input.selectionStart, end: this.input.selectionEnd };
    if (!this.write(state.source)) return;
    destination.push(before); this.input.value = this.buffer(); this.input.setSelectionRange(state.start, state.end); this.selection = state; this.paint();
  }
  private copy(event: ClipboardEvent, cut: boolean) {
    if (!event.clipboardData) return;
    const start = this.input.selectionStart, end = this.input.selectionEnd;
    let text = this.input.value.slice(start, end);
    if (this.target.kind !== 'formula') text = text.replace(/\ufffc/g, (_, i: number) => { const ch = this.projection.chars[start + i]; return this.current.slice(ch.from, ch.to); });
    event.preventDefault(); event.clipboardData.setData('text/plain', text);
    if (cut && start !== end) { this.selection = { start, end }; this.input.setRangeText('', start, end, 'end'); this.commit(); }
  }
  private navigate(key: string, shift: boolean) {
    const positions = this.positions(), offset = this.input.selectionDirection === 'backward' ? this.input.selectionStart : this.input.selectionEnd;
    const current = this.caret(positions, offset); if (!current) return false;
    const sameLine = (g: typeof positions[number], anchor: PageCharacter) => g.page === anchor.page && (anchor.line !== undefined ? g.line === anchor.line : Math.abs(g.y - anchor.y) < anchor.h * .4);
    const row = positions.filter(g => sameLine(g, current));
    let next: number | undefined;
    if (key === 'Home') next = Math.min(...row.map(g => g.start));
    else if (key === 'End') next = Math.max(...row.map(g => g.end));
    else {
      const below = key === 'ArrowDown';
      const candidates = positions.filter(g => !sameLine(g, current) && (below ? g.start > offset : g.end < offset));
      const adjacent = candidates.sort((a, b) => Math.abs(a.start - offset) - Math.abs(b.start - offset))[0]; if (!adjacent) return false;
      const nextRow = positions.filter(g => sameLine(g, adjacent));
      const x = current.x - Math.min(...row.map(g => g.x)) + Math.min(...nextRow.map(g => g.x));
      next = this.nearest(adjacent.page, x, adjacent.y + adjacent.h / 2);
    }
    if (next === undefined) return false;
    const anchor = this.input.selectionDirection === 'backward' ? this.input.selectionEnd : this.input.selectionStart;
    this.input.setSelectionRange(shift ? Math.min(anchor, next) : next, shift ? Math.max(anchor, next) : next, next < anchor ? 'backward' : 'forward');
    this.paint(); return true;
  }
  private caret(positions: ReturnType<PageEditor['positions']>, offset: number) {
    let best: (PageCharacter & { distance: number }) | undefined;
    for (const g of positions) {
      const after = offset >= g.end, distance = Math.min(Math.abs(offset - g.start), Math.abs(offset - g.end));
      if (!best || distance < best.distance || (distance === best.distance && !after)) best = { ...g, x: g.x + (after ? g.w : 0), distance };
    }
    return best;
  }
  private paint() {
    if (this.closed) return;
    for (const layer of this.layers.values()) layer.replaceChildren();
    const positions = this.positions(), start = this.input.selectionStart, end = this.input.selectionEnd;
    if (!this.composing) {
      const raw = (offset: number, end = false) => this.target.from + (this.target.kind === 'formula' ? offset : visualSourceOffset(this.current,this.projection,offset,end));
      const from = raw(start), to = raw(end,end>start), key = from + ':' + to;
      if (key !== this.lastCursor) { this.lastCursor = key; this.options.cursor?.(from, to); }
    }
    const box = (g: PageCharacter, className: string, width = g.w) => {
      const page = this.options.container.querySelector<HTMLElement>(`[data-page="${g.page}"]`); if (!page) return;
      let layer = this.layers.get(g.page);
      if (!layer || layer.parentElement !== page) { layer?.remove(); layer = document.createElement('div'); layer.className = 'rtex-page-edit-layer'; page.append(layer); this.layers.set(g.page, layer); }
      const scale = page.clientWidth / (Number.parseFloat(page.style.width) || page.clientWidth) * Number(page.style.getPropertyValue('--scale-factor') || 1);
      const node = document.createElement('div'); node.className = className; node.style.cssText = `left:${g.x * scale / SP_PER_BP}px;top:${g.y * scale / SP_PER_BP}px;width:${Math.max(width * scale / SP_PER_BP, 1.5)}px;height:${g.h * scale / SP_PER_BP}px;`; layer.append(node);
      return { page, scale };
    };
    if (this.target.kind !== 'formula') {
      const selected = positions.filter(g => g.start < end && g.end > start), runs: PageCharacter[] = [];
      for (const g of selected) {
        const last = runs.at(-1);
        if (last && last.page === g.page && Math.abs(last.y - g.y) < g.h * .1 && g.x >= last.x && g.x <= last.x + last.w + g.h) last.w = g.x + g.w - last.x;
        else runs.push({ ...g });
      }
      for (const run of runs) box(run, 'rtex-page-selection');
    }
    const caret = this.caret(positions, this.input.selectionDirection === 'backward' ? start : end); if (!caret) return;
    const location = box(caret, start === end && this.target.kind !== 'formula' ? 'rtex-page-caret' : 'rtex-page-caret hidden', 0); if (!location) return;
    const r = location.page.getBoundingClientRect(), factor = location.scale / SP_PER_BP;
    const formula = this.target.kind === 'formula', first = positions[0] || caret;
    this.input.style.left = r.left + (formula ? first.x : caret.x) * factor + 'px';
    this.input.style.top = r.top + (formula ? Math.max(...positions.map(g => g.y + g.h)) + SP_PER_BP * 3 : caret.y) * factor + 'px';
    this.input.style.fontSize = Math.max(12, caret.h * factor) + 'px';
    if (this.composing && !formula) {
      // Show only the uncommitted composition at the typeset caret. The native
      // textarea still owns the IME candidate window, keyboard and selection.
      if (!this.compositionPreview) { this.compositionPreview = document.createElement('div'); this.compositionPreview.className = 'rtex-page-composition'; document.body.append(this.compositionPreview); }
      this.compositionPreview.textContent = changeAtSelection(this.buffer(), this.input.value, this.selection.start, this.selection.end, 'insertCompositionText').inserted;
      this.compositionPreview.style.left = this.input.style.left; this.compositionPreview.style.top = this.input.style.top; this.compositionPreview.style.fontSize = this.input.style.fontSize;
    } else { this.compositionPreview?.remove(); this.compositionPreview = null; }
    if (formula) { this.input.style.width = Math.min(Math.max(160, this.input.value.length * 8), r.width - first.x * factor - 12) + 'px'; this.input.style.height = Math.max(24, Math.min(130, this.input.value.split('\n').length * 22)) + 'px'; }
  }
  close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.composing = false; this.commit();
    this.closed = true; this.stopDrag(); document.removeEventListener('pointerdown', this.outside);
    window.removeEventListener('scroll', this.reposition, true); window.removeEventListener('resize', this.reposition);
    for (const layer of this.layers.values()) layer.remove(); this.layers.clear(); this.compositionPreview?.remove(); this.input.remove(); this.options.boundary(); this.options.close();
  }
}
