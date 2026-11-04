import { blockInput, canEditAsText, formulaTarget, mathRegions, type BlockTarget } from './block-edit';
import { formattingIssue } from './format-guard';
import { selectionAfterEdit } from './editor-navigation';

interface Options {
  target: BlockTarget; viewport: HTMLElement; anchor: DOMRect;
  edit(from: number, to: number, expected: string, replacement: string): boolean;
  boundary(): void; close(): void; jump(offset: number): void;
  formula(target: BlockTarget): void;
}
const button = (text: string, title = '') => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; return b; };

/** A persistent page-side editor: preview repaints never replace the focused input. */
export class PageBlockEditor {
  readonly element = document.createElement('section');
  readonly input = document.createElement('textarea');
  private status = document.createElement('span');
  private modeButtons = document.createElement('div');
  private mathButtons = document.createElement('div');
  private current: string;
  private mode: 'text' | 'latex';
  private closed = false;
  private composing = false;
  private original: string;
  private localIssue: string | null = null;
  private textButton = button('文本');
  private latexButton = button('LaTeX');
  private wrapButton = button('自动折行', '仅改变编辑框显示，不改变 TeX 源码的换行');
  private displayWrapping = false;
  private child: PageBlockEditor | null = null;

  constructor(private options: Options) {
    const t = options.target; this.current = this.original = t.text; this.mode = t.mode;
    options.boundary();
    const card = this.element; card.className = 'rtex-block-editor'; card.setAttribute('role', 'region'); card.setAttribute('aria-label', t.kind === 'formula' ? '公式实时编辑器' : '段落实时编辑器');
    const header = document.createElement('header'); const title = document.createElement('strong'); title.textContent = t.label;
    const live = document.createElement('span'); live.className = 'rtex-editor-live'; live.textContent = 'LIVE';
    const close = button('×', '完成编辑'); close.className = 'rtex-editor-close'; close.onclick = () => this.close();
    header.append(live, title, close);
    const tools = document.createElement('div'); tools.className = 'rtex-editor-tools'; this.modeButtons.className = 'rtex-editor-modes';
    this.textButton.onclick = () => this.setMode('text'); this.latexButton.onclick = () => this.setMode('latex'); this.modeButtons.append(this.textButton, this.latexButton);
    const source = button('定位源码', t.file); source.onclick = () => { this.close(); options.jump(t.from); };
    tools.append(this.modeButtons, source);
    this.wrapButton.onclick = () => { this.displayWrapping = !this.displayWrapping; this.updateWrapping(); };
    tools.append(this.wrapButton);
    if (t.kind !== 'formula') { const insert = button('+ 行内公式'); insert.onclick = () => this.insert('\\(x^2\\)', 2, 5); tools.append(insert); }
    this.input.value = t.text; this.input.spellcheck = false; this.input.setAttribute('aria-label', t.kind === 'formula' ? '公式 LaTeX' : '整段内容'); this.input.rows = t.kind === 'formula' ? 4 : 6;
    this.updateWrapping();
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.commit(); });
    this.input.oninput = () => { if (!this.composing) this.commit(); };
    this.input.onkeydown = event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); this.close(); }
      if (event.key === 'Tab') { event.preventDefault(); this.input.setRangeText('  ', this.input.selectionStart, this.input.selectionEnd, 'end'); this.commit(); }
    };
    const hint = document.createElement('p'); hint.className = 'rtex-editor-hint';
    hint.textContent = t.kind === 'formula' ? '直接输入 LaTeX；原公式环境和编号保留，页面随输入重排。未完成的语法会暂留上次有效预览。' : '连续编辑整段，Enter 换行。含公式、引用或格式命令时使用 LaTeX 模式，保留原有结构。';
    const footer = document.createElement('footer'); this.status.className = 'rtex-editor-status'; this.status.textContent = '修改即时回写源码';
    const cancel = button('撤销本次', 'Esc'); cancel.onclick = () => this.close(true);
    const done = button('完成', 'Ctrl+Enter'); done.className = 'rtex-editor-done'; done.onclick = () => this.close(); footer.append(this.status, cancel, done);
    const origin = document.createElement('div'); origin.className = 'rtex-editor-origin'; origin.textContent = t.file + ' · TeX 原文片段';
    card.append(header, origin, tools);
    if (t.kind === 'formula') {
      const snippets = document.createElement('div'); snippets.className = 'rtex-editor-snippets';
      for (const [label, latex, cursor] of [['分式', '\\frac{a}{b}', 6], ['根式', '\\sqrt{x}', 6], ['上标', '^{2}', 2], ['求和', '\\sum_{i=1}^{N} x_i', 6], ['矩阵', '\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}', 15]] as const) { const b = button(label, latex); b.onclick = () => this.insert(latex, cursor, cursor + 1); snippets.append(b); }
      card.append(snippets);
    }
    this.mathButtons.className = 'rtex-editor-formulas'; card.append(this.mathButtons, this.input, hint, footer); document.body.append(card);
    this.updateModes(); this.updateMathButtons(); this.position(); this.input.focus(); this.input.setSelectionRange(0, 0);
    header.onpointerdown = event => {
      if ((event.target as HTMLElement).closest('button')) return;
      const rect = card.getBoundingClientRect(), x = event.clientX, y = event.clientY; header.setPointerCapture(event.pointerId);
      header.onpointermove = e => { card.style.left = Math.max(8, Math.min(innerWidth - card.offsetWidth - 8, rect.left + e.clientX - x)) + 'px'; card.style.top = Math.max(8, Math.min(innerHeight - card.offsetHeight - 8, rect.top + e.clientY - y)) + 'px'; };
      header.onpointerup = () => { header.onpointermove = null; header.onpointerup = null; };
    };
  }
  setSelection(from: number, to = from) { this.input.setSelectionRange(Math.max(0, from), Math.max(0, to)); }
  private updateWrapping() {
    this.input.wrap = this.displayWrapping ? 'soft' : 'off';
    this.input.style.whiteSpace = this.displayWrapping ? 'pre-wrap' : 'pre';
    this.input.style.overflowWrap = this.displayWrapping ? 'break-word' : 'normal';
    this.input.style.wordBreak = 'normal';
    this.wrapButton.classList.toggle('active', this.displayWrapping);
    this.wrapButton.setAttribute('aria-pressed', String(this.displayWrapping));
  }
  updateStatus(text: string, error = false) { if (this.closed) return; this.child?.updateStatus(text,error); if (this.localIssue) { text=this.localIssue; error=true; } this.status.textContent = text; this.status.classList.toggle('error', error); }
  close(revert = false) {
    if (this.closed) return;
    this.child?.close(revert);
    if (!revert) { this.composing = false; this.commit(); }
    if (revert && this.current !== this.original) this.options.edit(this.options.target.from, this.options.target.from + this.current.length, this.current, this.original);
    this.closed = true; this.options.boundary(); this.element.remove(); this.options.close();
  }
  private commit() {
    if (this.closed) return;
    const next = blockInput(this.mode, this.input.value); if (next === this.current) return;
    const t = this.options.target;
    if (t.kind !== 'formula') {
      const issue = formattingIssue(this.current,next);
      if (issue) {
        this.localIssue=issue;const caret=this.input.selectionStart;this.input.value=this.current;this.input.setSelectionRange(Math.min(caret,this.current.length),Math.min(caret,this.current.length));this.updateStatus(issue,true);return;
      }
    }
    if (!this.options.edit(t.from, t.from + this.current.length, this.current, next)) { this.updateStatus('源码已在其他位置改变，请重新打开此段', true); this.input.disabled = true; return; }
    this.localIssue = null; this.current = next; this.updateStatus('已同步 · 正在重排'); this.updateModes(); this.updateMathButtons();
  }
  private setMode(mode: 'text' | 'latex') {
    if (mode === this.mode || (mode === 'text' && !canEditAsText(this.current))) return;
    this.commit(); this.mode = mode; this.input.value = this.current; this.updateModes(); this.input.focus();
  }
  private updateModes() {
    const formula = this.options.target.kind === 'formula'; this.textButton.hidden = formula;
    this.textButton.disabled = this.mode !== 'text' && !canEditAsText(this.current);
    this.textButton.title = this.textButton.disabled ? '此段包含格式或公式命令，请保留 LaTeX 结构' : '输入普通文字，特殊字符自动转义';
    this.textButton.classList.toggle('active', this.mode === 'text'); this.latexButton.classList.toggle('active', this.mode === 'latex'); this.input.classList.toggle('rtex-prose-input', this.mode === 'text');
  }
  private updateMathButtons() {
    this.mathButtons.replaceChildren(); if (this.options.target.kind === 'formula') return;
    const regions = mathRegions(this.current);
    regions.forEach((region, index) => {
      const b = button(`公式 ${index + 1}`, this.current.slice(region.bodyFrom, region.bodyTo).trim());
      b.onclick = () => {
        this.composing=false;this.commit();
        const fresh=mathRegions(this.current)[index];if(!fresh)return;
        const relative = formulaTarget(this.current, fresh)!;
        const target = { ...relative, file: this.options.target.file, from: this.options.target.from + relative.from, to: this.options.target.from + relative.to };
        this.openFormula(target);
      }; this.mathButtons.append(b);
    });
  }
  private openFormula(target: BlockTarget) {
    this.commit(); this.localIssue=null;
    const source=this.current,selection={start:this.input.selectionStart,end:this.input.selectionEnd,top:this.input.scrollTop,left:this.input.scrollLeft};
    const parent=this,style={left:this.element.style.left,top:this.element.style.top,width:this.element.style.width};
    const child=new PageBlockEditor({target,anchor:this.options.anchor,viewport:this.options.viewport,
      edit:(from,to,expected,replacement)=>{
        const relative=from-this.options.target.from;
        if(this.current.slice(relative,relative+expected.length)!==expected||!this.options.edit(from,to,expected,replacement))return false;
        this.current=this.current.slice(0,relative)+replacement+this.current.slice(relative+expected.length);this.input.value=this.current;return true;
      },
      boundary:()=>this.options.boundary(),
      close:()=>{
        this.child=null;if(this.closed)return;
        this.element.style.display='';this.updateModes();this.updateMathButtons();
        const restored=selectionAfterEdit(source,this.current,selection.start,selection.end);this.input.focus();this.input.setSelectionRange(restored.start,restored.end);this.input.scrollTop=selection.top;this.input.scrollLeft=selection.left;
      },
      jump:offset=>{this.close();this.options.jump(offset);},formula:()=>{}
    });
    const back=button('← 返回整段','保留公式修改，返回原段落');back.className='rtex-editor-back';back.onclick=()=>child.close();
    child.element.querySelector('header')!.prepend(back);Object.assign(child.element.style,style);child.displayWrapping=this.displayWrapping;child.updateWrapping();
    parent.child=child;parent.element.style.display='none';
  }
  private insert(text: string, selectionFrom?: number, selectionTo?: number) {
    const start = blockInput(this.mode, this.input.value.slice(0, this.input.selectionStart)).length, end = blockInput(this.mode, this.input.value.slice(0, this.input.selectionEnd)).length;
    this.setMode('latex'); this.input.setSelectionRange(start, end);
    this.input.setRangeText(text, start, end, 'end'); this.commit(); this.input.focus();
    if (selectionFrom !== undefined) this.input.setSelectionRange(start + selectionFrom, start + (selectionTo ?? selectionFrom));
  }
  private position() {
    const viewport = this.options.viewport.getBoundingClientRect(), anchor = this.options.anchor, card = this.element;
    card.style.width = Math.max(280, Math.min(760, viewport.width - 32)) + 'px';
    const height = card.offsetHeight, below = viewport.bottom - anchor.bottom, above = anchor.top - viewport.top;
    const top = below >= height + 12 ? anchor.bottom + 10 : above >= height + 12 ? anchor.top - height - 10 : viewport.bottom - height - 18;
    card.style.left = Math.max(8, Math.min(viewport.right - card.offsetWidth - 16, Math.max(viewport.left + 16, anchor.left))) + 'px'; card.style.top = Math.max(viewport.top + 8, Math.min(innerHeight - height - 8, top)) + 'px';
  }
}
