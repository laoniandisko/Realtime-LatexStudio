import { runAgentSession, shouldSendChatKey, type AgentChange } from './agent-session';
import {workspaceRequest} from './workspace-request';
import { ChatImages, boundedChatHistory, type ChatMessage } from './chat-images';
import { parseCompileProblems, type CompileProblem } from './diagnostics';
import { decodeBase64 } from './binary';
/* SideX LaTeX mode. Reuses the upstream Monaco / xterm dependencies and MIT
 * license, with a focused workbench and a loopback-only local compiler bridge. */
import './style.css';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { type SourceFile } from './source-map';
import { pdfEditTargets } from './pdf-target';
import { PageBlockEditor } from './rtex/block-editor';
import { type BlockTarget } from './rtex/block-edit';
import { mergeParagraphRects, type Fragment } from './rtex/paragraph-regions';
import { RealtimePreview } from './rtex/preview';
import type { FileChange } from './rtex/paragraph-move';
import { showModelSettings, type ModelSettings } from './model-settings';

GlobalWorkerOptions.workerSrc = pdfWorker;
(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const icon = (name: string) => `<i class="codicon codicon-${name}" aria-hidden="true"></i>`;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
let pageBlockEditor: PageBlockEditor | null = null;
let syncingPageCursor = false;
let sourceCursorTimer: ReturnType<typeof setTimeout> | undefined;
const pageMoveHistory: FileChange[][] = [];
let files: SourceFile[] = [], active = 'main.tex', root = '', token = '', main = 'main.tex';
let models = new Map<string, monaco.editor.ITextModel>(), saved = new Map<string, string>(), viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
let compiling = false, pdf: PDFDocumentProxy | null = null, pdfBytes: Uint8Array | null = null, renderGeneration = 0, compileSnapshot = '';
let zoom = 0, currentPage = 1, editEnabled = true, autoCompile = false, autoTimer: ReturnType<typeof setTimeout>;
let compiledMain = '', terminalSocket: WebSocket | null = null, modelConfigured = false, chatting = false;
const messages: ChatMessage[] = [];
let agentController: AbortController | null = null;
let compilationLog = '', errors: CompileProblem[] = [], toastTimer: ReturnType<typeof setTimeout>;
let sourceSelection: string | null = null;
interface CompileJob { id: string; controller: AbortController; cancelled: boolean; timedOut: boolean; cancelling: boolean }
let currentCompile: CompileJob | null = null;
const pdfRenderTasks = new Set<{ cancel(): void }>();

$('app').innerHTML = `
  <header class="titlebar">
    <div class="brand"><span class="brand-mark">S</span>SideX <small>LATEX STUDIO</small></div>
    <button class="icon-btn" id="home-link" title="保存并返回项目主页" aria-label="项目主页">${icon('home')}</button>
    <nav class="menubar" aria-label="主菜单"><button id="menu-file">文件</button><button id="menu-edit">编辑</button><button id="menu-view">视图</button><button id="menu-help">帮助</button></nav>
    <button class="command-center" id="command-center">${icon('search')}<span id="command-name">latex-paper</span><span class="spacer"></span><kbd>Ctrl K</kbd></button>
    <div class="title-actions"><button class="icon-btn" id="toggle-sidebar" title="切换资源管理器">${icon('layout-sidebar-left')}</button><button class="icon-btn" id="toggle-bottom" title="切换底部面板">${icon('layout-panel')}</button><button class="icon-btn" id="settings-top" title="模型设置">${icon('settings-gear')}</button></div>
  </header>
  <div class="workspace">
    <nav class="activity" aria-label="活动栏">
      <button class="active" id="activity-files" title="资源管理器">${icon('files')}</button><button id="activity-search" title="搜索源码">${icon('search')}</button><button id="activity-outline" title="文档大纲">${icon('list-tree')}</button><button id="activity-build" title="编译文档">${icon('play')}</button><button id="activity-agent" title="智能体">${icon('sparkle')}</button><div class="spacer"></div><button id="activity-help" title="使用说明">${icon('question')}</button><button id="activity-settings" title="设置">${icon('settings-gear')}</button>
    </nav>
    <aside class="sidebar">
      <div class="side-heading">资源管理器<div class="side-actions"><button class="icon-btn" id="new-file" title="新建文件">${icon('new-file')}</button><button class="icon-btn" id="open-project" title="打开项目目录">${icon('folder-opened')}</button></div></div>
      <div id="file-search" class="search-box hidden"><input id="file-filter" placeholder="搜索文件…" aria-label="搜索文件"></div>
      <div class="project-label">${icon('chevron-down')}<span id="project-label">LATEX-PAPER</span><span class="spacer"></span></div>
      <div class="tree" id="file-tree"></div>
      <div class="side-section"><div class="section-heading">${icon('chevron-down')}文档大纲</div><div class="outline" id="outline"></div></div>
      <div class="project-info"><span class="dot"></span>本地工作区<br>Monaco · TeX · PDF.js<br><span style="color:#a196b1">基于 Sidenai / Sidex</span></div>
    </aside>
    <main class="content" id="content">
      <div class="workspace-toolbar"><span class="workspace-name">${icon('book')}<span id="workspace-name">latex-paper</span><span class="project-tag">/ research workspace</span></span><span class="spacer"></span><span id="compile-state" class="toolbar-state"><span class="dot"></span>准备就绪</span><button id="auto-compile" class="icon-btn" title="自动编译：关闭">${icon('sync')}</button><div class="compile-group"><button class="primary" id="compile-btn">${icon('play')}编译</button><select id="engine" aria-label="编译引擎"><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></div></div>
      <div class="top-panels" id="top-panels">
        <section class="editor-pane" aria-label="TeX 源码编辑器">
          <div class="tabs"><div id="source-tabs" style="display:flex;min-width:0;overflow:auto"></div><span class="spacer"></span><div class="tab-tools"><button class="icon-btn" id="choose-main" title="设为主文件">${icon('pinned')}</button><button class="icon-btn" id="source-to-pdf" title="定位到 PDF（SyncTeX）">${icon('go-to-file')}</button><button class="icon-btn" id="save-file" title="保存全部 Ctrl S">${icon('save')}</button></div></div>
          <div class="breadcrumb"><span id="breadcrumb-root">latex-paper</span>${icon('chevron-right')}<span class="current" id="breadcrumb-file">main.tex</span></div>
          <div class="editor-wrap"><div class="editor-host" id="editor"></div></div>
          <div class="source-footer">${icon('link')}<span>源码与 PDF 联动</span><span class="spacer"></span><span id="main-label">主文件 main.tex</span></div>
        </section>
        <div class="v-sash" id="split-sash" role="separator" aria-label="调整源码与 PDF 宽度"></div>
        <section class="preview-pane" aria-label="PDF 预览">
          <div class="tabs"><div class="tab">${icon('file-pdf')}<span id="pdf-tab-name">main.pdf</span></div><span class="spacer"></span><div class="tab-tools"><span id="preview-mode" class="badge" style="margin-right:8px">完整 PDF · 可编辑</span></div></div>
          <div class="pdf-toolbar"><button class="icon-btn" id="prev-page" title="上一页">${icon('chevron-left')}</button><input id="page-number" class="page-input" type="number" min="1" value="1" aria-label="PDF 页码"><span class="muted">/ <span id="page-count">—</span></span><button class="icon-btn" id="next-page" title="下一页">${icon('chevron-right')}</button><span class="divider"></span><button class="icon-btn" id="zoom-out" title="缩小">${icon('remove')}</button><button id="zoom-label" class="zoom-label" title="适合宽度">适合宽度</button><button class="icon-btn" id="zoom-in" title="放大">${icon('add')}</button><button class="icon-btn" id="fit-page" title="适合宽度">${icon('screen-full')}</button><button id="edit-toggle" class="edit-toggle">${icon('edit')}编辑 PDF</button><button class="icon-btn" id="download-pdf" title="下载 PDF">${icon('desktop-download')}</button></div>
          <div class="pdf-scroll" id="pdf-scroll"><div class="pdf-placeholder" id="pdf-placeholder">${icon('file-pdf')}<p>让想法，落在纸上。<br><span class="muted">编译 TeX，即可预览真实 PDF。</span></p><button class="secondary" id="first-compile">${icon('play')}编译文档 <kbd>Ctrl Enter</kbd></button></div><div class="pdf-pages" id="pdf-pages"></div></div>
          <div class="pdf-footnote" id="pdf-hint">${icon('edit')}双击正文编辑整段 / 双击公式在线修改</div>
        </section>
      </div>
      <div class="h-sash" id="bottom-sash" role="separator" aria-label="调整底部面板高度"></div>
      <div class="bottom-panels" id="bottom-panels">
        <section class="terminal-pane" aria-label="终端与编译日志"><div class="panel-header"><button class="panel-tab active" data-panel="terminal">终端</button><button class="panel-tab" data-panel="log">编译日志</button><button class="panel-tab" data-panel="problems">问题 <span id="problem-count" class="count">0</span></button><div class="shell-label">${icon('terminal-powershell')}<span id="shell-label">PowerShell</span></div><button class="icon-btn" id="restart-terminal" title="重新连接终端">${icon('add')}</button><button class="icon-btn" id="clear-terminal" title="清空终端">${icon('clear-all')}</button></div><div id="terminal" class="terminal-area"></div><pre id="log" class="log-area hidden">等待编译。Ctrl + Enter 编译主文件。</pre><div id="problems" class="problems-area hidden"><div class="empty-problems">${icon('check')}暂无编译问题</div></div></section>
        <section class="agent-pane" aria-label="智能体对话"><div class="panel-header agent-header"><span class="agent-title">${icon('sparkle')}</span><span class="badge" style="align-self:center;font-size:8px">LATEX</span><span class="spacer"></span><button class="model-label" id="model-label">配置模型 ${icon('chevron-down')}</button><button class="icon-btn" id="clear-chat" title="新建对话">${icon('new-file')}</button></div><div class="agent-scroll" id="agent-scroll"><div id="chat-messages"></div></div><div class="agent-composer"><div class="context-row">${icon('file-code')}<span id="context-file">main.tex</span><label><input type="checkbox" id="include-context" checked>附上当前文件</label></div><div id="chat-images" class="chat-images hidden"></div><textarea id="chat-input" aria-label="给智能体的消息" placeholder="描述你想完成的修改…"></textarea><div class="compose-actions"><span id="agent-status">可跨文件读写项目</span><button class="icon-btn" id="attach-image" title="添加图片，也可在输入框粘贴截图" aria-label="添加图片">${icon('file-media')}</button><button class="send-btn" id="send-message" title="Enter 发送 · Shift+Enter 换行">${icon('arrow-up')}</button></div></div></section>
      </div>
    </main>
  </div>
  <footer class="statusbar"><button class="remote" id="local-info" title="本地工作区">${icon('remote')}</button><span class="status-item">${icon('source-control')}local</span><button class="status-item" id="status-problems">${icon('error')}<span id="status-errors">0</span>${icon('warning')}0</button><span class="status-item green" id="save-state">${icon('check')}已保存</span><span class="status-right"><span id="cursor-position">Ln 1, Col 1</span><span class="optional">UTF-8</span><span>LaTeX</span><span id="status-engine">pdfLaTeX</span><span class="optional">${icon('check-all')}本地编译</span><button id="status-notifications" title="使用说明">${icon('bell')}</button></span></footer>
  <div id="toast" class="toast hidden" role="status"></div><div id="modal-root"></div>
`;

const chatImages = new ChatImages($('chat-images'), message => toast(message,true));
const imagePicker=document.createElement('input');imagePicker.type='file';imagePicker.accept='image/png,image/jpeg,image/webp,image/gif';imagePicker.multiple=true;imagePicker.hidden=true;document.body.append(imagePicker);imagePicker.onchange=()=>{chatImages.add(Array.from(imagePicker.files||[]));imagePicker.value='';};
$('attach-image').onclick=()=>imagePicker.click();
$('chat-input').addEventListener('paste',event=>chatImages.paste(event as ClipboardEvent));
$('include-context').closest('label')!.title='智能体始终可以访问当前项目；此项仅决定是否附上当前编辑内容或选区。';
const stopButton = document.createElement('button');
stopButton.id = 'cancel-compile'; stopButton.className = 'compile-cancel hidden';
stopButton.innerHTML = `${icon('debug-stop')}中断`;
stopButton.title = '中断编译并停止编译进程';
stopButton.setAttribute('aria-label', '中断编译');
$('compile-btn').parentElement!.insertBefore(stopButton, $('compile-btn'));
const liveButton = document.createElement('button'); liveButton.id = 'realtime-toggle'; liveButton.className = 'realtime-toggle';
liveButton.innerHTML = `${icon('zap')}实时预览`; liveButton.title = 'realtime-tex · LuaLaTeX 段落实时更新';
$('auto-compile').parentElement!.insertBefore(liveButton, $('auto-compile'));
const sourceToggle=document.createElement('button');sourceToggle.id='toggle-source';sourceToggle.className='source-toggle';sourceToggle.title='切换源码编辑区 Ctrl+Alt+E';
$('fit-page').insertAdjacentElement('afterend',sourceToggle);
function setSourceHidden(hidden: boolean){
  $('top-panels').classList.toggle('source-hidden',hidden);sourceToggle.textContent=hidden?'显示源码':'隐藏源码';sourceToggle.setAttribute('aria-pressed',String(hidden));
  localStorage.setItem('sidex-latex-source-hidden',String(hidden));requestAnimationFrame(()=>editor.layout());
}
sourceToggle.onclick=()=>setSourceHidden(!$('top-panels').classList.contains('source-hidden'));
const undoMoveButton=document.createElement('button');undoMoveButton.className='icon-btn hidden';undoMoveButton.title='撤销上次段落或图表移动';undoMoveButton.setAttribute('aria-label','撤销上次段落或图表移动');undoMoveButton.innerHTML=icon('discard');sourceToggle.insertAdjacentElement('afterend',undoMoveButton);
function applyPageChanges(changes: FileChange[], remember = true){
  if(changes.some(c=>!models.has(c.file)||models.get(c.file)!.getValue()!==c.before))return false;
  for(const change of changes){const model=models.get(change.file)!;model.pushStackElement();model.pushEditOperations([], [{range:model.getFullModelRange(),text:change.after}],()=>null);model.pushStackElement();}
  if(remember){pageMoveHistory.push(changes);if(pageMoveHistory.length>20)pageMoveHistory.shift();}undoMoveButton.classList.toggle('hidden',pageMoveHistory.length===0);return true;
}
undoMoveButton.onclick=()=>{const changes=pageMoveHistory.at(-1);if(!changes)return;if(!applyPageChanges(changes.map(c=>({file:c.file,before:c.after,after:c.before})),false))return toast('移动后文件已有其他修改，请在源码中使用撤销。');pageMoveHistory.pop();undoMoveButton.classList.toggle('hidden',pageMoveHistory.length===0);toast('已撤销段落或图表移动。');};

monaco.languages.register({ id: 'latex' });
monaco.languages.setMonarchTokensProvider('latex', {
  tokenizer: { root: [[/%.*$/, 'comment'], [/\\(?:begin|end)\b/, 'keyword'], [/\\[a-zA-Z@]+\*?/, 'keyword'], [/\\./, 'string.escape'], [/\$\$?/, 'type'], [/[{}\[\]]/, 'delimiter.bracket'], [/[0-9]+(?:\.[0-9]+)?/, 'number'], [/&/, 'delimiter'], [/[^\\%${}\[\]&\d]+/, '']] }
});
monaco.languages.setLanguageConfiguration('latex', { comments: { lineComment: '%' }, brackets: [['{', '}'], ['[', ']'], ['(', ')']], autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '$', close: '$' }] });
monaco.languages.registerCompletionItemProvider('latex', { triggerCharacters: ['\\'], provideCompletionItems(model, position) {
  const word = model.getWordUntilPosition(position), range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
  return { suggestions: ['section', 'subsection', 'textbf', 'emph', 'cite', 'ref', 'label', 'input', 'includegraphics', 'frac', 'begin', 'end'].map(label => ({ label: '\\' + label, kind: monaco.languages.CompletionItemKind.Function, insertText: label + '{${1}}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range })) };
} });
monaco.editor.defineTheme('sidex-latex', { base: 'vs-dark', inherit: true,
  rules: [{ token: 'keyword', foreground: 'C2A7EF' }, { token: 'comment', foreground: '6F8B7A', fontStyle: 'italic' }, { token: 'type', foreground: 'D3B985' }, { token: 'number', foreground: 'D2B68A' }, { token: 'delimiter.bracket', foreground: 'C1B8D3' }, { token: '', foreground: 'C8CCD8' }],
  colors: { 'editor.background': '#1b1d24', 'editor.foreground': '#c8ccd8', 'editorLineNumber.foreground': '#545b6b', 'editorLineNumber.activeForeground': '#bca5e8', 'editor.lineHighlightBackground': '#252730', 'editor.selectionBackground': '#6f57865c', 'editorCursor.foreground': '#c9adee', 'editorIndentGuide.background1': '#303440', 'editorGutter.background': '#1b1d24', 'editorWidget.background': '#282631', 'editorWidget.border': '#554563' }
});
const editor = monaco.editor.create($('editor'), { theme: 'sidex-latex', language: 'latex', fontSize: 12, fontFamily: "'Cascadia Code', 'Consolas', 'Microsoft YaHei', monospace", lineHeight: 21, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on', lineNumbersMinChars: 3, glyphMargin: false, folding: true, renderLineHighlight: 'line', padding: { top: 13, bottom: 15 }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on', tabSize: 2, overviewRulerBorder: false, fixedOverflowWidgets: true });
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveAll());
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => compile());
editor.onDidChangeCursorPosition(e => {
  $('cursor-position').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  if(!syncingPageCursor&&editor.hasTextFocus()){
    clearTimeout(sourceCursorTimer);sourceCursorTimer=setTimeout(()=>{const model=editor.getModel(),position=editor.getPosition();if(realtime.enabled&&model&&position)void realtime.focusSource(active,model.getOffsetAt(position));},70);
  }
});
editor.onDidChangeCursorSelection(() => { const selection = editor.getSelection(); sourceSelection = selection && !selection.isEmpty() ? editor.getModel()!.getValueInRange(selection) : null; });

const terminal = new Terminal({ theme: { background: '#1b1d24', foreground: '#b7c4bd', cursor: '#c1a2e9', selectionBackground: '#6e557655', black: '#1b1d24', brightBlack: '#697082', green: '#9bc6aa', brightGreen: '#bddcc8', blue: '#95b7d9', magenta: '#bda2e2' }, fontFamily: "'Cascadia Code', 'Consolas', monospace", fontSize: 11, lineHeight: 1.25, cursorBlink: true, scrollback: 2000, allowProposedApi: false });
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($('terminal'));
new ResizeObserver(() => { if (!$('terminal').classList.contains('hidden')) { try { fit.fit(); } catch {} } }).observe($('terminal'));
terminal.onData(data => { if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: 'input', data })); });
terminal.onResize(size => { if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: 'resize', ...size })); });

const realtime = new RealtimePreview({
  container: $('pdf-pages'), viewport: $('pdf-scroll'), token: () => token, main: () => main, files: getFiles,
  editing: () => editEnabled,
  editFiles: changes => applyPageChanges(changes),
  cursor: (file,from,to) => {
    const model=models.get(file);if(!model)return;syncingPageCursor=true;
    try{if(active!==file)openFile(file);const start=model.getPositionAt(from),end=model.getPositionAt(to);editor.setSelection(monaco.Range.fromPositions(start,end));if(!$('top-panels').classList.contains('source-hidden'))editor.revealPositionInCenterIfOutsideViewport(start);}
    finally{syncingPageCursor=false;}
  },
  beforeEdit: () => closePageEditor(true),
  log: text => { compilationLog = (compilationLog + text).slice(-150000); $('log').textContent = compilationLog; },
  fallback: reason => {
    if (!realtime.enabled) return;
    if (pageBlockEditor) { disableRealtime(false); pageBlockEditor.updateStatus('此模板使用完整编译，完成后更新 PDF'); return; }
    terminal.writeln('\r\n\x1b[33m[realtime-tex] ' + reason.replace(/\r?\n/g, ' ').slice(0, 250) + '\x1b[0m');
    toast('当前模板与实时引擎不兼容，正在使用所选引擎完整编译。');
    void compile();
  },
  notify: (text, error) => toast(text, error),
  status: (text, kind) => {
    pageBlockEditor?.updateStatus(text, kind === 'error');
    updatePreviewMode();
    liveButton.classList.toggle('active', realtime.enabled);
    $('pdf-hint').textContent = text;
    $('pdf-hint').classList.toggle('dirty-preview', kind === 'error');
    if (realtime.enabled && (kind === 'ready' || kind === 'live')) $('pdf-placeholder').classList.add('hidden');
    if (!compiling) { $('compile-state').textContent = text; $('compile-state').title = '实时预览使用 LuaLaTeX；右侧编译按钮保留所选原引擎。'; }
  },
  pages: count => { $('page-count').textContent = String(count); ($('page-number') as HTMLInputElement).max = String(count); },
  editBoundary: file => models.get(file)?.pushStackElement(),
  edit: (file, from, to, expected, replacement) => {
    const model = models.get(file); if (!model || model.getValue().slice(from, to) !== expected) return false;
    if (active !== file) openFile(file);
    editor.executeEdits('realtime-page-edit', [{ range: monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to)), text: replacement, forceMoveMarkers: true }]);
    editor.revealPositionInCenterIfOutsideViewport(model.getPositionAt(from)); return true;
  },
  jump: (file, offset) => { setSourceHidden(false);openFile(file); const position = editor.getModel()!.getPositionAt(offset); editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); }
});
setSourceHidden(localStorage.getItem('sidex-latex-source-hidden')==='true');
async function enableRealtime(preservePdf = false) {
  if (compiling) return toast('请先中断或等待当前编译结束。');
  const available = await api('realtime-status');
  if (!available.installed) return toast('realtime-tex 尚未安装。', true);
  if (!main) return toast('请先设置 .tex 主文件。', true);
  clearTimeout(autoTimer); autoCompile = false; $('auto-compile').style.color = '';
  $('pdf-tab-name').textContent = '实时排版 · ' + main;
  if (!preservePdf) $('pdf-placeholder').classList.remove('hidden');
  await realtime.start({ preservePdf }); localStorage.setItem('sidex-latex-live-v2:' + root, 'true');
  $('status-engine').textContent = 'LuaLaTeX · 实时';
  liveButton.classList.add('active'); stopButton.classList.remove('hidden'); stopButton.title = '停止实时预览及其后台编译';
}
function disableRealtime(persist = true) {
  realtime.stop(); if (!compiling) stopButton.classList.add('hidden'); liveButton.classList.remove('active'); $('pdf-tab-name').textContent = main.replace(/\.tex$/, '.pdf');
  $('status-engine').textContent = ($('engine') as HTMLSelectElement).selectedOptions[0].text;
  if (persist) localStorage.setItem('sidex-latex-live-v2:' + root, 'false');
  if (pdf) $('pdf-pages').replaceChildren();
  if (pdf) { $('pdf-placeholder').classList.add('hidden'); void renderPdf(); }
  else if (realtime.pageCount) { $('pdf-placeholder').classList.add('hidden'); $('pdf-hint').textContent = '实时预览已停止 · 点击编译生成可编辑 PDF'; }
  else $('pdf-placeholder').classList.remove('hidden');
  updateState();
  if (!pdf && realtime.pageCount) $('pdf-hint').textContent = '实时预览已停止 · 点击编译生成可编辑 PDF';
}

function toast(message: string, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = 'toast' + (error ? ' error' : ''); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 7000 : 4000); }
const appFetch:typeof fetch=(input,init)=>workspaceRequest(String(input),init||{},()=>({id:new URLSearchParams(location.search).get('project'),root,token}),value=>{token=value;});
async function api<T = any>(operation: string, data: any = {}, signal?: AbortSignal, timeoutMs = operation === 'chat' ? 125000 : ['models', 'model'].includes(operation) ? 20000 : 15000): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await appFetch('/__latex/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Latex-Token': token }, body: JSON.stringify(data), signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
function snapshot() { return JSON.stringify(files.map(f => [f.name, models.get(f.name)?.getValue() ?? f.content])); }
function getFiles() { return files.map(f => ({ name: f.name, content: models.get(f.name)?.getValue() ?? f.content })); }
function isDirty(name: string) { return models.get(name)?.getValue() !== saved.get(name); }
function anyDirty() { return files.some(f => isDirty(f.name)); }
function updatePreviewMode() {
  $('preview-mode').textContent = !editEnabled ? '阅读模式' : realtime.enabled ? '页面内编辑 · 正文 / 公式' : '完整 PDF · 双击编辑';
  $('preview-mode').title = realtime.enabled ? '点击正文直接输入，拖动选字；点击公式就地修改 LaTeX；Alt+双击编辑源码' : '双击正文或公式直接编辑，兼容项目自动启用实时重排';
}
function updateState() {
  updatePreviewMode();
  $('pdf-pages').classList.toggle('pdf-read-mode', !editEnabled);
  const dirty = anyDirty();
  $('save-state').innerHTML = dirty ? `${icon('circle-filled')}未保存` : `${icon('check')}已保存`;
  $('save-state').classList.toggle('green', !dirty);
  const stale = !realtime.enabled && !!pdf && snapshot() !== compileSnapshot;
  $('pdf-hint').innerHTML = stale ? `${icon('history')}预览已过期 · 重新编译后可编辑 PDF` : `${icon('edit')}${editEnabled ? '双击 PDF 文字，直接修改并回写 TeX' : '阅读模式 · 可选择和复制 PDF 文字'}`;
  $('pdf-hint').classList.toggle('dirty-preview', stale);
  if (realtime.enabled) { $('pdf-hint').innerHTML = `${icon('zap')}点击直接编辑 · 拖动选字 · Ctrl+Z 撤销 · Esc 结束 · Alt+双击源码`; }
  for (const f of files) { const mark = document.querySelector(`[data-dirty="${CSS.escape(f.name)}"]`); if (mark) mark.textContent = isDirty(f.name) ? '●' : ''; }
  const tabMark = $('active-dirty'); if (tabMark) tabMark.textContent = isDirty(active) ? '●' : '';
}
function renderTree(filter = '') {
  $('file-tree').innerHTML = files.filter(f => f.name.toLowerCase().includes(filter.toLowerCase())).map(f => `<button class="file-row ${f.name === active ? 'active' : ''}" data-file="${escape(f.name)}" title="${escape(f.name)}"><span class="${f.name.endsWith('.bib') ? 'bib-icon' : 'tex-icon'}">${f.name.endsWith('.tex') ? 'TᴇX' : f.name.endsWith('.bib') ? '≡' : '⌘'}</span><span class="file-name">${escape(f.name)}</span><span class="dirty-mark" data-dirty="${escape(f.name)}">${isDirty(f.name) ? '●' : ''}</span></button>`).join('');
  $('file-tree').querySelectorAll<HTMLButtonElement>('[data-file]').forEach(b => b.onclick = () => openFile(b.dataset.file!));
}
function renderOutline() {
  const source = editor.getValue(); const sections = [...source.matchAll(/\\(sub)*section\*?\{([^}]*)\}/g)]; let num = 0;
  $('outline').innerHTML = sections.map((m, i) => `<button data-outline="${i}" title="${escape(m[2])}" style="padding-left:${m[1] ? 24 : 9}px"><span class="section-num">${m[1] ? '·' : ++num}</span>${escape(m[2])}</button>`).join('') || '<span class="small-label" style="padding:6px 9px;display:block">此文件没有章节</span>';
  $('outline').querySelectorAll<HTMLButtonElement>('[data-outline]').forEach(b => b.onclick = () => { const m = sections[Number(b.dataset.outline)]; const pos = editor.getModel()!.getPositionAt(m.index!); editor.revealLineInCenter(pos.lineNumber); editor.setPosition(pos); editor.focus(); });
}
function openFile(name: string) {
  if (!models.has(name)) return;
  if (editor.getModel()) viewStates.set(active, editor.saveViewState());
  active = name; editor.setModel(models.get(name)!); const state = viewStates.get(name); if (state) editor.restoreViewState(state);
  $('source-tabs').innerHTML = `<button class="tab" title="${escape(name)}"><span class="tex-icon">${name.endsWith('.tex') ? 'TᴇX' : '≡'}</span>${escape(name)}<span id="active-dirty" class="dirty-mark"></span></button>`;
  $('breadcrumb-file').textContent = name; $('context-file').textContent = name; renderTree(($('file-filter') as HTMLInputElement).value); renderOutline(); updateState();
}
async function loadProject(project: { files: SourceFile[]; root: string; name: string }) {
  pageMoveHistory.length=0;undoMoveButton.classList.add('hidden');
  agentController?.abort();
  if(root&&root!==project.root){messages.length=0;chatImages.clear();$('chat-messages').replaceChildren();}
  closePageEditor(true);
  if (realtime.enabled) realtime.stop(false);
  editor.setModel(null); for (const model of models.values()) model.dispose(); models.clear(); saved.clear(); viewStates.clear(); files = project.files; root = project.root;
  for (const f of files) {
    const model = monaco.editor.createModel(f.content, f.name.endsWith('.tex') || f.name.endsWith('.bib') ? 'latex' : 'plaintext', monaco.Uri.parse('inmemory://latex/' + encodeURIComponent(f.name)));
    models.set(f.name, model); saved.set(f.name, f.content);
    model.onDidChangeContent(() => { updateState(); if (f.name === active) renderOutline(); realtime.documentChanged(f.name, model.getValue()); clearTimeout(autoTimer); if (autoCompile && !realtime.enabled) autoTimer = setTimeout(() => compile(), 1300); });
  }
  const preferredMain=localStorage.getItem('sidex-latex-main:'+root);
  main=files.find(f=>f.name===preferredMain&&f.name.endsWith('.tex'))?.name||files.find(f=>f.name==='main.tex')?.name||files.find(f=>f.name.endsWith('.tex')&&/\\documentclass/.test(f.content))?.name||files.find(f=>f.name.endsWith('.tex'))?.name||'';
  $('project-label').textContent = project.name.toUpperCase(); $('workspace-name').textContent = project.name; $('command-name').textContent = project.name; $('breadcrumb-root').textContent = project.name; document.title = `${project.name} — SideX LaTeX Studio`;
  $('main-label').textContent = '主文件 ' + (main || '未设置'); $('pdf-tab-name').textContent = main.replace(/\.tex$/, '.pdf') || 'preview.pdf';
  if (files.length) openFile(main || files[0].name);
  pdf?.destroy(); pdf = null; pdfBytes = null; compileSnapshot = ''; $('pdf-pages').replaceChildren(); $('pdf-placeholder').classList.remove('hidden'); $('page-count').textContent = '—'; currentPage = 1;
  connectTerminal();
  try {
    const draft = JSON.parse(localStorage.getItem('sidex-latex-draft:' + root) || 'null');
    if (draft && typeof draft === 'object') {
      const modified = Object.keys(draft).filter(name => models.has(name) && draft[name].base === saved.get(name) && draft[name].content !== saved.get(name));
      if (modified.length) { for (const name of modified) models.get(name)!.setValue(draft[name].content); toast('已恢复上次关闭时未保存的修改。'); }
    }
  } catch {}
}
async function saveAll(signal?: AbortSignal) {
  try {
    const changed = getFiles().filter(f => saved.get(f.name) !== f.content);
    if (changed.length) { await api('save', { files: changed }, signal); for (const f of changed) saved.set(f.name, f.content); }
    localStorage.removeItem('sidex-latex-draft:' + root); updateState(); toast('所有文件已保存'); return true;
  } catch (e: any) { if (signal?.aborted) throw e; toast('保存失败：' + e.message, true); return false; }
}
function selectPanel(name: string) {
  for (const panel of ['terminal', 'log', 'problems']) $(panel).classList.toggle('hidden', panel !== name);
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  if (name === 'terminal') requestAnimationFrame(() => { fit.fit(); terminal.focus(); });
}
function renderProblems() {
  $('problem-count').textContent=String(errors.length);$('status-errors').textContent=String(errors.length);
  $('problems').innerHTML=errors.length?errors.map((error,index)=>`<div class="problem" role="button" tabindex="0" data-error="${index}">${icon('error')} ${escape(error.message)}${error.file?`<br><span class="muted">${escape(error.file)}${error.line?' : '+error.line:''}</span>`:error.line?`<br><span class="muted">行 ${error.line}（详见编译日志）</span>`:''}</div>`).join(''):`<div class="empty-problems">${icon('check')}未发现编译错误</div>`;
  $('problems').querySelectorAll<HTMLElement>('[data-error]').forEach(button=>button.onclick=()=>{
    const error=errors[Number(button.dataset.error)],file=error.file;
    if(!file||!models.has(file))return selectPanel('log');
    openFile(file);if(error.line){const line=Math.min(error.line,models.get(file)!.getLineCount());editor.revealLineInCenter(line);editor.setPosition({lineNumber:line,column:1});editor.focus();}
  });
  for(const [file,model] of models)monaco.editor.setModelMarkers(model,'latex-compiler',errors.filter(error=>error.file===file&&error.line).map(error=>{
    const line=Math.min(error.line!,model.getLineCount());return {severity:monaco.MarkerSeverity.Error,message:error.message,startLineNumber:line,endLineNumber:line,startColumn:1,endColumn:model.getLineMaxColumn(line)};
  }));
}
function bounded<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('操作已中断', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('PDF 预览处理超时，请重新编译。')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function finishCompile(job: CompileJob) {
  if (currentCompile !== job) return;
  currentCompile = null; compiling = false;
  $('compile-btn').removeAttribute('disabled'); $('compile-btn').innerHTML = `${icon('play')}编译`;
  $('engine').removeAttribute('disabled'); $('first-compile').removeAttribute('disabled');
  stopButton.classList.add('hidden'); stopButton.removeAttribute('disabled'); stopButton.innerHTML = `${icon('debug-stop')}中断`;
}
async function cancelCompile() {
  const job = currentCompile; if (!job || job.cancelling) return;
  job.cancelled = true; job.cancelling = true; clearTimeout(autoTimer);
  $('compile-state').textContent = '正在中断…'; stopButton.setAttribute('disabled', ''); stopButton.innerHTML = `${icon('loading codicon-modifier-spin')}中断中`;
  job.controller.abort();
  try {
    await api('cancel-compile', { id: job.id }, undefined, 8000);
    if (currentCompile === job) {
      $('compile-state').textContent = '已中断';
      terminal.writeln('\r\n\x1b[33m[LaTeX] 编译已中断，可重新编译。\x1b[0m');
      toast('编译已中断');
    }
  } catch (e: any) {
    $('compile-state').textContent = '中断请求未确认'; toast('中断请求未确认：' + e.message, true);
  } finally { finishCompile(job); }
}
async function compile() {
  if (compiling) return;
  closePageEditor(true);
  if (realtime.enabled) disableRealtime(false);
  if (!main) return toast('请先打开或创建 .tex 主文件。', true);
  const job: CompileJob = { id: crypto.randomUUID(), controller: new AbortController(), cancelled: false, timedOut: false, cancelling: false };
  currentCompile = job; compiling = true;
  const signal = job.controller.signal, sourceMain = main;
  const previous = { pdf, bytes: pdfBytes, snapshot: compileSnapshot, main: compiledMain };
  let candidate: PDFDocumentProxy | null = null, loadingTask: ReturnType<typeof getDocument> | null = null, committed = false, statusPending = false;
  const stopPreview = () => { renderGeneration++; for (const task of pdfRenderTasks) task.cancel(); void loadingTask?.destroy().catch(() => {}); };
  signal.addEventListener('abort', stopPreview, { once: true });
  const deadline = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, 85000);
  const progress = setInterval(async () => {
    if (statusPending || signal.aborted || currentCompile !== job) return;
    statusPending = true;
    try {
      const status = await api('compile-status', {}, signal, 4000);
      if (status.active && status.id === job.id && currentCompile === job && !signal.aborted) {
        $('compile-state').textContent = `${status.phase} · ${Math.floor(status.elapsed / 1000)}s`;
        if (status.log) { compilationLog = status.log; $('log').textContent = compilationLog; }
      }
    } catch {} finally { statusPending = false; }
  }, 1000);
  $('compile-btn').setAttribute('disabled', ''); $('compile-btn').innerHTML = `${icon('loading codicon-modifier-spin')}编译中`;
  $('engine').setAttribute('disabled', ''); $('first-compile').setAttribute('disabled', '');
  stopButton.classList.remove('hidden'); $('compile-state').textContent = '正在保存…';
  try {
    if (!await saveAll(signal)) { $('compile-state').textContent = '保存失败'; return; }
    signal.throwIfAborted();
    const source = snapshot(), engine = ($('engine') as HTMLSelectElement).value;
    $('compile-state').textContent = '正在编译…';
    terminal.writeln(`\r\n\x1b[38;5;141m[LaTeX]\x1b[0m ${engine} ${sourceMain}`);
    const result = await api('compile', { main: sourceMain, engine, id: job.id }, signal, 70000);
    signal.throwIfAborted();
    compilationLog = result.log || ''; $('log').textContent = compilationLog;
    if (result.cancelled) { $('compile-state').textContent = '已中断'; terminal.writeln('\x1b[33m[LaTeX] 编译已中断。\x1b[0m'); return; }
    errors = parseCompileProblems(compilationLog,main,files.map(file=>file.name));
    if (!result.ok && !errors.length) errors.push({ message: result.timedOut ? '编译超时（60 秒），编译进程已停止。' : '编译未成功，请查看完整日志。' });
    renderProblems();
    if (!result.ok) { $('compile-state').textContent = result.timedOut ? '编译超时' : '编译失败'; terminal.writeln('\x1b[31m[LaTeX] 编译未成功，请查看编译日志。\x1b[0m'); selectPanel('problems'); toast(errors[0]?.message || '编译失败', true); return; }
    const bytes = await decodeBase64(result.pdf);
    $('compile-state').textContent = '正在加载 PDF…';
    loadingTask = getDocument({ data: bytes.slice(), isEvalSupported: false });
    candidate = await bounded(loadingTask.promise, signal, 15000); signal.throwIfAborted();
    pdf = candidate; pdfBytes = bytes; compileSnapshot = source; compiledMain = sourceMain;
    $('page-count').textContent = String(pdf.numPages); ($('page-number') as HTMLInputElement).max = String(pdf.numPages);
    $('pdf-placeholder').classList.add('hidden'); $('compile-state').textContent = '正在渲染 PDF…';
    await renderPdf(signal); signal.throwIfAborted(); committed = true; loadingTask = null;
    void previous.pdf?.destroy().catch(() => {});
    const seconds = (result.duration / 1000).toFixed(1); $('compile-state').innerHTML = `<span class="dot"></span>已编译 · ${seconds}s`;
    terminal.writeln(`\x1b[32m[LaTeX] 成功 · ${pdf.numPages} 页 · ${seconds}s\x1b[0m`); updateState();
  } catch (e: any) {
    if (!job.cancelled) {
      job.controller.abort();
      try { await api('cancel-compile', { id: job.id }, undefined, 5000); } catch {}
      const message = job.timedOut || e.name === 'TimeoutError' ? '编译或预览超时，已停止；可重新编译。' : e.message;
      $('compile-state').textContent = job.timedOut || e.name === 'TimeoutError' ? '编译超时' : '编译失败';
      $('log').textContent = compilationLog + '\n' + message; errors = [{ message }]; renderProblems(); toast(message, true);
    }
  } finally {
    clearInterval(progress); clearTimeout(deadline); signal.removeEventListener('abort', stopPreview);
    if (!committed && candidate && pdf === candidate) {
      pdf = previous.pdf; pdfBytes = previous.bytes; compileSnapshot = previous.snapshot; compiledMain = previous.main;
      void candidate.destroy().catch(() => {});
      if (pdf) { $('page-count').textContent = String(pdf.numPages); void renderPdf().catch(() => {}); }
      else { $('pdf-pages').replaceChildren(); $('pdf-placeholder').classList.remove('hidden'); $('page-count').textContent = '—'; }
      updateState();
    }
    if (!committed && loadingTask) void loadingTask.destroy().catch(() => {});
    if (!job.cancelling) finishCompile(job);
  }
}
async function renderPdf(signal?: AbortSignal) {
  if (realtime.enabled) { realtime.setZoom(zoom); return; }
  if (!pdf) return;
  const generation = ++renderGeneration, doc = pdf, scroll = $('pdf-scroll');
  const oldTop = scroll.scrollTop; $('pdf-pages').replaceChildren();
  for (let n = 1; n <= doc.numPages; n++) {
    if (generation !== renderGeneration) return;
    signal?.throwIfAborted();
    const page = await bounded(doc.getPage(n), signal); const original = page.getViewport({ scale: 1 });
    const scale = zoom || Math.min(1.6, Math.max(.28, (scroll.clientWidth - 48) / original.width));
    const viewport = page.getViewport({ scale });
    const container = document.createElement('div'); container.className = 'pdf-page'; container.dataset.page = String(n); container.style.width = viewport.width + 'px'; container.style.height = viewport.height + 'px'; container.style.setProperty('--scale-factor', String(scale));
    const canvas = document.createElement('canvas'); const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr); canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px'; container.append(canvas);
    $('pdf-pages').append(container);
    const renderTask = page.render({ canvasContext: canvas.getContext('2d')!, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
    pdfRenderTasks.add(renderTask);
    try { await bounded(renderTask.promise, signal); }
    catch (e) { renderTask.cancel(); throw e; }
    finally { pdfRenderTasks.delete(renderTask); }
    if (generation !== renderGeneration) return;
    const layerDiv = document.createElement('div'); layerDiv.className = 'textLayer'; container.append(layerDiv);
    const textContent = await bounded(page.getTextContent(), signal); const layer = new TextLayer({ textContentSource: textContent, container: layerDiv, viewport }); await bounded(layer.render(), signal);
    decoratePdfParagraphs(layerDiv, container, n);
    layerDiv.addEventListener('dblclick', event => {
      const target = event.target as HTMLElement; const span = target.closest('span'); if (!span || !span.textContent?.trim()) return;
      const rect = container.getBoundingClientRect(); const x = (event.clientX - rect.left) / scale, y = (event.clientY - rect.top) / scale;
      if (editEnabled) { event.preventDefault(); window.getSelection()?.removeAllRanges(); const paragraph = [...container.querySelectorAll<HTMLElement>('.pdf-paragraph-hit')].find(r => r.dataset.blockKey === span.dataset.blockKey); void editPdfText(span.textContent, n, x, y, (paragraph || span).getBoundingClientRect()); }
      else if (event.ctrlKey || event.metaKey) { event.preventDefault(); void reverseSync(n, x, y); }
    });
    if (n === 1) $('zoom-label').textContent = `${Math.round(scale * 100)}%`;
  }
  scroll.scrollTop = oldTop;
}
async function reverseHint(page: number, x: number, y: number) {
  try { const result = await api('synctex', { main: compiledMain, page, x, y }); if (result.file && result.Line) return { file: result.file as string, line: Number(result.Line) }; } catch {}
  return undefined;
}
async function reverseSync(page: number, x: number, y: number) {
  const hint = await reverseHint(page, x, y); if (!hint || !models.has(hint.file)) return toast('该位置没有可用的 SyncTeX 映射。');
  openFile(hint.file); editor.revealLineInCenter(hint.line); editor.setPosition({ lineNumber: hint.line, column: 1 }); editor.focus();
}
function closePageEditor(suppressCompile = false) {
  const card = pageBlockEditor; if (!card) return;
  if (suppressCompile) pageBlockEditor = null;
  card.close();
}
function supportsLiveEditing() {
  return !getFiles().some(f => /\\documentclass(?:\[[^\]]*\])?\s*\{acmart\}|\\usepackage(?:\[[^\]]*\])?\s*\{axessibility\}/.test(f.content));
}
function decoratePdfParagraphs(layer: HTMLElement, container: HTMLElement, page: number) {
  const fragments: Fragment<BlockTarget>[] = [], origin = container.getBoundingClientRect(), sourceFiles = getFiles();
  for (const span of layer.querySelectorAll<HTMLElement>('span')) {
    if (!span.textContent?.trim()) continue;
    const targets = pdfEditTargets(span.textContent, sourceFiles); if (targets.length !== 1 || targets[0].kind === 'formula') continue;
    const target = targets[0], key = target.file + ':' + target.from; span.dataset.blockKey = key;
    const r = span.getBoundingClientRect(); if (!r.width || !r.height) continue;
    fragments.push({ key, page, target, rows: [], rect: { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height } });
  }
  for (const fragment of mergeParagraphRects(fragments)) {
    const region = document.createElement('div'); region.className = 'pdf-paragraph-hit'; region.dataset.blockKey = fragment.key; const r = fragment.rect;
    region.style.cssText = 'left:' + (r.x - 3) + 'px;top:' + (r.y - 3) + 'px;width:' + (r.w + 6) + 'px;height:' + (r.h + 6) + 'px;'; container.append(region);
  }
  layer.onpointermove = event => {
    const key = editEnabled ? (event.target as HTMLElement).closest<HTMLElement>('[data-block-key]')?.dataset.blockKey : '';
    container.querySelectorAll<HTMLElement>('.pdf-paragraph-hit').forEach(r => r.classList.toggle('hover', !!key && r.dataset.blockKey === key));
  };
  layer.onpointerleave = () => container.querySelectorAll('.pdf-paragraph-hit.hover').forEach(r => r.classList.remove('hover'));
}
async function openPdfTarget(target: BlockTarget, anchor: DOMRect) {
  const model = models.get(target.file); if (!model || model.getValue().slice(target.from, target.to) !== target.text) return toast('源码已改变，请重新选择此段。');
  closePageEditor(true); realtime.closeEditor(); clearTimeout(autoTimer); autoCompile = false; $('auto-compile').style.color = '';
  const before = snapshot();
  const card = new PageBlockEditor({ target, anchor, viewport: $('pdf-scroll'),
    edit: (from, to, expected, replacement) => {
      const current = models.get(target.file); if (!current || current.getValue().slice(from, to) !== expected) return false;
      if (active !== target.file) openFile(target.file);
      editor.executeEdits('pdf-block-edit', [{ range: monaco.Range.fromPositions(current.getPositionAt(from), current.getPositionAt(to)), text: replacement, forceMoveMarkers: true }]);
      return true;
    },
    boundary: () => models.get(target.file)?.pushStackElement(),
    close: () => { const shouldCompile = pageBlockEditor === card && !realtime.enabled && snapshot() !== before; pageBlockEditor = null; if (shouldCompile) void compile(); },
    jump: offset => { openFile(target.file); const position = model.getPositionAt(offset); editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); },
    formula: next => void openPdfTarget(next, anchor)
  }); pageBlockEditor = card;
  if (realtime.enabled) return;
  if (supportsLiveEditing()) { try { const status = await api('realtime-status'); if (pageBlockEditor === card && status.installed && status.texlive) await enableRealtime(true); } catch { card.updateStatus('实时引擎不可用 · 完成后完整编译'); } }
  else card.updateStatus('完整编译模式 · 完成后更新 PDF');
}
async function editPdfText(text: string, page: number, x: number, y: number, anchor: DOMRect) {
  if (snapshot() !== compileSnapshot || main !== compiledMain) return toast('源码已变化，请编译后重新选择，或开启实时预览。', true);
  const hint = await reverseHint(page, x, y), targets = pdfEditTargets(text, getFiles(), hint);
  if (!targets.length) return toast('此位置暂未找到可编辑的段落或公式，请使用源码定位按钮。');
  if (targets.length === 1) return openPdfTarget(targets[0], anchor);
  modal('<div class="dialog-head">选择编辑内容<button class="icon-btn" data-close>×</button></div><div class="dialog-body"><p>此行有多处源码内容，请选择要编辑的整段或公式。</p><select id="pdf-target-choice">' + targets.map((t, i) => '<option value="' + i + '">' + escape(t.label + ' · ' + t.text.slice(0, 90)) + '</option>').join('') + '</select></div><div class="dialog-actions"><button class="primary" id="open-pdf-target">开始编辑</button></div>');
  $('open-pdf-target').onclick = () => { const target = targets[Number(($('pdf-target-choice') as HTMLSelectElement).value)]; closeModal(); void openPdfTarget(target, anchor); };
}
async function forwardSync() {
  if (realtime.enabled) { const position = editor.getPosition(); if (position) realtime.focusSource(active, editor.getModel()!.getOffsetAt(position)); return; }
  if (!pdf || snapshot() !== compileSnapshot || main !== compiledMain) return toast('请先编译当前源码。');
  try {
    const line = editor.getPosition()?.lineNumber || 1; const r = await api('synctex', { direction: 'forward', main, file: active, line });
    const pageNumber = Number(r.Page); const page = document.querySelector<HTMLElement>(`.pdf-page[data-page="${pageNumber}"]`);
    if (!page) return toast('当前位置没有 PDF 映射。');
    page.scrollIntoView({ block: 'start', behavior: 'smooth' }); const scale = Number(page.style.getPropertyValue('--scale-factor'));
    const high = document.createElement('div'); high.className = 'sync-highlight'; high.style.top = `${Math.max(0, (Number(r.v || r.y) - 12) * scale)}px`; page.append(high); setTimeout(() => high.remove(), 2500); setPage(pageNumber, false);
  } catch (e: any) { toast(e.message, true); }
}
function setPage(n: number, scroll = true) {
  if (realtime.enabled) { currentPage = Math.max(1, Math.min(realtime.pageCount, n)); ($('page-number') as HTMLInputElement).value = String(currentPage); if (scroll) realtime.scrollToPage(currentPage); return; }
  if (!pdf) return; currentPage = Math.max(1, Math.min(pdf.numPages, n)); ($('page-number') as HTMLInputElement).value = String(currentPage);
  if (scroll) document.querySelector(`.pdf-page[data-page="${currentPage}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function downloadPdf() { if (realtime.enabled) { realtime.export(); return; } if (!pdfBytes) return toast('请先编译生成 PDF。'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([pdfBytes.slice()], { type: 'application/pdf' })); a.download = main.replace(/^.*[\\/]/, '').replace(/\.tex$/, '.pdf'); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
async function connectTerminal() {
  try{await api('realtime-status');}catch(error:any){toast(error.message,true);return;}
  terminalSocket?.close(); terminal.clear(); terminal.writeln('\x1b[38;5;141mSideX\x1b[0m · 本地项目终端\r\n');
  terminalSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__latex/terminal?token=${encodeURIComponent(token)}`);
  const socket = terminalSocket;
  socket.onopen = () => { fit.fit(); socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); };
  socket.onmessage = e => { const msg = JSON.parse(e.data); if (msg.type === 'data') terminal.write(msg.data); };
  socket.onclose = () => { if (socket === terminalSocket) terminal.writeln('\r\n\x1b[90m终端连接已关闭。点击 + 重新连接。\x1b[0m'); };
}
function modal(html: string, className = '') { $('modal-root').innerHTML = `<div class="modal-backdrop"><section class="dialog ${className}" role="dialog" aria-modal="true">${html}</section></div>`; $('modal-root').querySelectorAll<HTMLElement>('[data-close]').forEach(b => b.onclick = closeModal); const first = $('modal-root').querySelector<HTMLElement>('input, textarea, button'); first?.focus(); }
function closeModal() { $('modal-root').replaceChildren(); }
function applyModelSettings(settings: ModelSettings) {
  modelConfigured = settings.configured;
  $('model-label').innerHTML = settings.configured ? escape(settings.model) + ' ' + icon('chevron-down') : '选择模型 ' + icon('chevron-down');
  $('model-label').title = '已发现 ' + settings.models.length + ' 个模型 · 点击切换';
  $('agent-status').textContent = settings.configured ? '模型已连接 · ' + settings.models.length + ' 个可用模型' : '填写 API 地址和密钥，自动获取模型';
  localStorage.setItem('sidex-latex-model', JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model }));
}
function showSettings() {
  void showModelSettings({ api, modal, close: closeModal, saved: applyModelSettings, notify: toast });
}
function addMessage(role: string, content: string) { const element = document.createElement('div'); element.className = 'message ' + role; element.innerHTML = `<div class="role">${icon(role === 'user' ? 'account' : 'sparkle')}${role === 'user' ? '你' : '智能体'}</div><div class="text"></div>`; element.querySelector('.text')!.textContent = content; $('chat-messages').append(element); $('agent-scroll').scrollTop = $('agent-scroll').scrollHeight; return element; }
function applyAgentChange(change:AgentChange) {
  if(change.binary||typeof change.content!=='string')return;
  let model=models.get(change.path),file=files.find(file=>file.name===change.path);
  if(!model){
    file={name:change.path,content:change.content};files.push(file);
    model=monaco.editor.createModel(change.content,/\.(tex|bib|sty|cls)$/.test(change.path)?'latex':'plaintext',monaco.Uri.parse('inmemory://latex/'+encodeURIComponent(change.path)));models.set(change.path,model);
    const watched=model;model.onDidChangeContent(()=>{updateState();if(active===change.path)renderOutline();realtime.documentChanged(change.path,watched.getValue());});
    realtime.documentChanged(change.path,change.content);
  }else if(model.getValue()===change.before||!isDirty(change.path)){
    if(model.getValue()!==change.content){model.pushStackElement();model.pushEditOperations([],[{range:model.getFullModelRange(),text:change.content}],()=>null);model.pushStackElement();}
  }else toast('保留了你正在输入的内容：'+change.path+'；智能体的磁盘修改可在差异中查看。');
  saved.set(change.path,change.content);if(file)file.content=change.content;
  renderTree(($('file-filter') as HTMLInputElement).value);if(active===change.path)renderOutline();updateState();
}
function reviewAgentChange(change:AgentChange) {
  if(change.binary||typeof change.content!=='string')return toast('二进制文件已写入项目：'+change.path);
  modal(`<div class="dialog-head">${icon('diff')}已写入 · ${escape(change.path)}<button class="icon-btn" data-close>${icon('close')}</button></div><div class="dialog-body"><p>${change.created?'新建文件：左侧为空，右侧为已写入内容。':'左侧为修改前，右侧为本次写入内容。编辑器中可使用 Ctrl+Z 撤销，再保存。'}</p></div><div id="diff-host" class="diff-host"></div><div class="dialog-actions"><button class="primary" data-close>关闭</button></div>`,'diff-dialog');
  const before=monaco.editor.createModel(change.before||'','latex'),after=monaco.editor.createModel(change.content,'latex'),diff=monaco.editor.createDiffEditor($('diff-host'),{theme:'sidex-latex',readOnly:true,automaticLayout:true,minimap:{enabled:false}});diff.setModel({original:before,modified:after});
  const dispose=()=>{diff.dispose();before.dispose();after.dispose();closeModal();};$('modal-root').querySelectorAll<HTMLElement>('[data-close]').forEach(button=>button.onclick=dispose);
}
async function sendMessage() {
  const input=$('chat-input') as HTMLTextAreaElement,raw=input.value,prompt=raw.trim();if((!prompt&&!chatImages.count)||chatting)return;
  if(!modelConfigured){toast('请先配置模型，再发送消息。');showSettings();return;}
  const messageRoot=root,controller=new AbortController();agentController=controller;chatting=true;
  $('send-message').innerHTML=icon('debug-stop');$('send-message').title='停止智能体';
  let pending:HTMLElement|null=null,answer='',changed=0;
  try{
    const captured=await chatImages.capture();controller.signal.throwIfAborted();
    const text=prompt||'请查看附图。',content=captured.parts.length?[{type:'text' as const,text},...captured.parts]:text;
    if(input.value===raw)input.value='';captured.consume();
    const user=addMessage('user',text);for(const part of captured.parts){const image=document.createElement('img');image.className='chat-message-image';image.src=part.image_url.url;image.alt='发送给智能体的图片';user.append(image);}
    messages.push({role:'user',content});pending=addMessage('assistant','正在处理…');
    const trace=document.createElement('div');trace.className='agent-tool-trace';pending.append(trace);
    const context=($('include-context') as HTMLInputElement).checked?(sourceSelection?'Selected text:\n'+sourceSelection:editor.getValue()):'';
    const extra=/编译|error|compile/i.test(text)?'\nCompilation log:\n'+compilationLog.slice(-20000):'';
    await runAgentSession(token,{projectRoot:messageRoot,messages:boundedChatHistory(messages),file:active,context:context+extra,documents:getFiles().filter(file=>isDirty(file.name)).map(file=>({...file,base:saved.get(file.name)}))},controller.signal,event=>{
      if(root!==messageRoot||event.root!==messageRoot)return;
      if(event.type==='thinking')$('agent-status').textContent='智能体处理中 · 第 '+event.round+' 轮';
      if(event.type==='tool-start'){
        const labels:Record<string,string>={list_files:'浏览目录',read_file:'读取文件',search_files:'搜索项目',edit_file:'修改文件',write_file:'写入文件'};
        const row=document.createElement('div');row.className='agent-tool-row';row.dataset.call=event.id;row.textContent=(labels[event.name!]||event.name)+' · '+(event.path||event.query||'项目');trace.append(row);$('agent-status').textContent=row.textContent;
      }
      if(event.type==='tool-end'){
        const row=[...trace.querySelectorAll<HTMLElement>('[data-call]')].find(row=>row.dataset.call===event.id);if(row){row.classList.toggle('failed',!event.ok);row.textContent+=(event.ok?' ✓':' · '+event.error);}
      }
      if(event.type==='file-change'&&event.change){
        const change=event.change;applyAgentChange(change);changed++;
        const card=document.createElement('div');card.className='edit-proposal';const desc=document.createElement('div');desc.textContent=change.path+' · 已写入';const view=document.createElement('button');view.textContent=change.binary?'文件信息':'查看差异';view.onclick=()=>reviewAgentChange(change);card.append(desc,view);pending!.append(card);
      }
      if(event.type==='commentary'||event.type==='answer'){answer=event.content||'';pending!.querySelector('.text')!.textContent=answer;}
      if(event.type==='done'){answer=event.content||answer||'已完成。';pending!.querySelector('.text')!.textContent=answer;$('agent-status').textContent=event.changedFiles?.length?'已更新 '+event.changedFiles.length+' 个项目文件':'智能体已完成';}
      $('agent-scroll').scrollTop=$('agent-scroll').scrollHeight;
    },appFetch);
    messages.push({role:'assistant',content:answer||'已完成。'});
  }catch(error:any){
    const message=controller.signal.aborted?'已停止，已完成的文件修改已保留。':'执行失败：'+error.message;
    if(pending)pending.querySelector('.text')!.textContent=message;else toast(message,true);$('agent-status').textContent=changed?'已保留 '+changed+' 次文件修改':message;
  }finally{if(agentController===controller)agentController=null;chatting=false;$('send-message').innerHTML=icon('arrow-up');$('send-message').title='Enter 发送 · Shift+Enter 换行';}
}
async function openProjectHome(){if(anyDirty()&&!await saveAll())return;location.assign('/home');}
function showOpenProject(){void openProjectHome();}
function showNewFile() {
  modal(`<div class="dialog-head">${icon('new-file')}新建文件<button class="icon-btn" data-close>${icon('close')}</button></div><div class="dialog-body"><label class="field">文件名<input id="new-filename" placeholder="section.tex"></label><p>支持 .tex、.bib、.sty、.cls 和普通文字文件。</p></div><div class="dialog-actions"><button class="secondary" data-close>取消</button><button class="primary" id="confirm-new">创建</button></div>`);
  $('confirm-new').onclick = async () => { const name = ($('new-filename') as HTMLInputElement).value.trim(); if (!/^[\p{L}\p{N}_ .-]+\.(tex|bib|sty|cls|txt|md)$/u.test(name) || name.startsWith('.')) return toast('请使用有效文件名，例如 section.tex。', true); try { await api('create', { name, content: '' }); const model = monaco.editor.createModel('', name.endsWith('.tex') ? 'latex' : 'plaintext', monaco.Uri.parse('inmemory://latex/' + encodeURIComponent(name))); files.push({ name, content: '' }); models.set(name, model); saved.set(name, ''); model.onDidChangeContent(() => { updateState(); renderOutline(); realtime.documentChanged(name, model.getValue()); }); closeModal(); openFile(name); editor.focus(); } catch (e: any) { toast(e.message, true); } };
}
function showHelp() {
  modal(`<div class="dialog-head">${icon('book')}欢迎使用 SideX LaTeX Studio<button class="icon-btn" data-close>${icon('close')}</button></div><div class="dialog-body"><p>在左侧编写 TeX，右侧查看真实编译的 PDF。底部是本地终端和模型对话。</p><div class="hint-box"><b>Ctrl S</b> 保存全部文件<br><b>Ctrl Enter</b> 编译主文件<br><b>Ctrl K</b> 命令面板<br><b>双击 PDF 正文</b> 整段连续编辑，Enter 换行，Ctrl+Enter 完成<br><b>双击公式</b> 修改 LaTeX，实时更新页面<br><b>Alt + 双击单词</b> 只修改一个词<br><b>阅读模式 + Ctrl 双击</b> 跳转到对应源码<br><b>拖动分隔线</b> 调整编辑器和底部面板大小</div><p>PDF 直接编辑支持能明确定位的连续文字。实时模式支持整段、标题、行内公式和行间公式编辑；复杂格式或宏保留 LaTeX 编辑模式。支持 \input 多文件项目；会议模板：CVPR、ICCV、ICLR 已验证实时段落预览；ECCV 和 ACM（MM、SIGGRAPH）使用完整编译。字体、引用和分页以完整 PDF 为准。请安装 TeX Live 或 MiKTeX；缺失宏包时，安装对应宏包后重新编译。</p><p>输入 API 地址和密钥后自动获取模型。智能体可搜索、读取并直接修改整个项目的文件，修改后显示差异。Enter 发送消息，Shift+Enter 换行；支持粘贴截图或添加图片，图片输入需使用支持视觉的模型。</p><p style="font-size:10px">基于 <a href="https://github.com/Sidenai/sidex" target="_blank" rel="noreferrer" style="color:#c1a9ec">Sidenai / Sidex</a>，保留 MIT 许可证。本应用在浏览器中运行，项目与排版处理由本机服务提供。</p></div><div class="dialog-actions"><button class="primary" data-close>开始写作</button></div>`);
}
function showPalette() {
  const commands = [
    { name: 'LaTeX: 编译主文件', key: 'Ctrl Enter', action: compile, glyph: 'play' }, { name: '文件: 保存全部', key: 'Ctrl S', action: saveAll, glyph: 'save' }, { name: '文件: 打开项目目录', action: showOpenProject, glyph: 'folder-opened' }, { name: '文件: 新建文件', action: showNewFile, glyph: 'new-file' }, { name: '视图: 显示/隐藏源码', key: 'Ctrl Alt E', action: () => sourceToggle.click(), glyph: 'layout-sidebar-left' }, { name: 'PDF: 下载编译结果', action: downloadPdf, glyph: 'desktop-download' }, { name: 'PDF: 定位当前源码', action: forwardSync, glyph: 'go-to-file' }, { name: '智能体: 模型设置', action: showSettings, glyph: 'sparkle' }, { name: '终端: 显示终端', action: () => selectPanel('terminal'), glyph: 'terminal' }, { name: '帮助: 使用说明', action: showHelp, glyph: 'book' }
  ];
  modal('<input id="palette-input" placeholder="输入命令名称…" aria-label="搜索命令"><div id="palette-items" class="palette-items"></div>', 'palette');
  const draw = (query: string) => { const filtered = commands.filter(c => c.name.toLowerCase().includes(query.toLowerCase())); $('palette-items').innerHTML = filtered.map((c, i) => `<button data-command="${i}">${icon(c.glyph)}${escape(c.name)}${c.key ? `<kbd>${c.key}</kbd>` : ''}</button>`).join(''); $('palette-items').querySelectorAll<HTMLButtonElement>('[data-command]').forEach(b => b.onclick = () => { const action = filtered[Number(b.dataset.command)].action; closeModal(); void action(); }); };
  draw(''); const input = $('palette-input') as HTMLInputElement; input.oninput = () => draw(input.value); input.onkeydown = e => { if (e.key === 'Enter') ($('palette-items').querySelector('button') as HTMLButtonElement)?.click(); }; input.focus();
}

// Resizable workspace, persisted independently of document state.
function sash(element: HTMLElement, onMove: (e: PointerEvent) => void) {
  element.onpointerdown = e => { e.preventDefault(); const shield = document.createElement('div'); shield.style.cssText = 'position:fixed;inset:0;z-index:200;cursor:' + (element.id === 'split-sash' ? 'col-resize' : 'row-resize'); document.body.append(shield); shield.onpointermove = onMove; shield.onpointerup = () => { shield.remove(); localStorage.setItem('sidex-latex-layout', JSON.stringify({ split: document.documentElement.style.getPropertyValue('--split'), bottom: document.documentElement.style.getPropertyValue('--bottom') })); }; shield.setPointerCapture(e.pointerId); };
}
sash($('split-sash'), e => { const rect = $('top-panels').getBoundingClientRect(); document.documentElement.style.setProperty('--split', Math.max(25, Math.min(75, (e.clientX - rect.left) / rect.width * 100)) + '%'); });
sash($('bottom-sash'), e => { const rect = $('content').getBoundingClientRect(); document.documentElement.style.setProperty('--bottom', Math.max(120, Math.min(rect.height - 220, rect.bottom - e.clientY)) + 'px'); });
try { const layout = JSON.parse(localStorage.getItem('sidex-latex-layout') || '{}'); for (const k of ['split', 'bottom']) if (/^[\d.]+(px|%)$/.test(layout[k])) document.documentElement.style.setProperty('--' + k, layout[k]); } catch {}

for (const id of ['compile-btn', 'first-compile', 'activity-build']) $(id).onclick = () => compile();
stopButton.onclick = () => { if (realtime.enabled) disableRealtime(); else void cancelCompile(); };
liveButton.onclick = () => { if (realtime.enabled) disableRealtime(); else void enableRealtime().catch(e => toast(e.message, true)); };
for (const id of ['settings-top', 'activity-settings', 'model-label']) $(id).onclick = showSettings;
for (const id of ['menu-help', 'activity-help', 'status-notifications']) $(id).onclick = showHelp;
for (const id of ['open-project', 'menu-file']) $(id).onclick = showOpenProject;
for (const id of ['command-center', 'menu-view']) $(id).onclick = showPalette;
$('menu-edit').onclick = () => { editor.focus(); editor.getAction('actions.find')?.run(); };
$('home-link').onclick=()=>void openProjectHome();
$('new-file').onclick = showNewFile; $('save-file').onclick = () => saveAll(); $('source-to-pdf').onclick = () => forwardSync(); $('download-pdf').onclick = downloadPdf;
$('choose-main').onclick = async () => { if (!active.endsWith('.tex')) return toast('请选择 .tex 文件。'); main=active;localStorage.setItem('sidex-latex-main:'+root,main);$('main-label').textContent='主文件 '+main;$('pdf-tab-name').textContent=main.replace(/\.tex$/,'.pdf');toast('已设置主文件：'+main);updateState();if(realtime.enabled)await realtime.start(); };
$('engine').onchange = () => { if (realtime.enabled) return; $('status-engine').textContent = ($('engine') as HTMLSelectElement).selectedOptions[0].text; };
$('auto-compile').onclick = () => { if (realtime.enabled) disableRealtime(); autoCompile = !autoCompile; $('auto-compile').style.color = autoCompile ? '#bba4f2' : ''; $('auto-compile').title = '自动编译：' + (autoCompile ? '开启' : '关闭'); toast('自动编译已' + (autoCompile ? '开启' : '关闭')); };
$('edit-toggle').onclick = () => { editEnabled = !editEnabled; if (!editEnabled) { closePageEditor(true); realtime.closeEditor(); } $('edit-toggle').classList.toggle('off', !editEnabled); $('edit-toggle').innerHTML = icon(editEnabled ? 'edit' : 'eye') + (editEnabled ? '编辑 PDF' : '阅读模式'); updateState(); };
$('prev-page').onclick = () => setPage(currentPage - 1); $('next-page').onclick = () => setPage(currentPage + 1); $('page-number').onchange = () => setPage(Number(($('page-number') as HTMLInputElement).value) || 1);
$('zoom-in').onclick = () => { zoom = Math.min(2.5, (zoom || parseInt($('zoom-label').textContent!) / 100 || .7) + .1); void renderPdf(); };
$('zoom-out').onclick = () => { zoom = Math.max(.3, (zoom || parseInt($('zoom-label').textContent!) / 100 || .7) - .1); void renderPdf(); };
for (const id of ['fit-page', 'zoom-label']) $(id).onclick = () => { zoom = 0; void renderPdf(); };
$('pdf-scroll').onscroll = () => { const rect = $('pdf-scroll').getBoundingClientRect(); let closest = 1, distance = Infinity; $('pdf-pages').querySelectorAll<HTMLElement>('.pdf-page').forEach(p => { const d = Math.abs(p.getBoundingClientRect().top - rect.top - 20); if (d < distance) { closest = Number(p.dataset.page); distance = d; } }); if (closest !== currentPage) setPage(closest, false); };
document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(b => b.onclick = () => selectPanel(b.dataset.panel!));
$('restart-terminal').onclick = connectTerminal; $('clear-terminal').onclick = () => terminal.clear(); $('status-problems').onclick = () => selectPanel('problems');
$('send-message').onclick=()=>{if(chatting)agentController?.abort();else void sendMessage();}; $('chat-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();if(shouldSendChatKey(event))void sendMessage();}};
$('clear-chat').onclick = () => { if (chatting) return; messages.length = 0; chatImages.clear(); $('chat-messages').replaceChildren();  };
$('activity-agent').onclick = () => $('chat-input').focus();
let sidebarShown = true, bottomShown = true;
$('toggle-sidebar').onclick = () => { sidebarShown = !sidebarShown; document.documentElement.style.setProperty('--sidebar', sidebarShown ? '210px' : '0px'); document.querySelector<HTMLElement>('.sidebar')!.style.display = sidebarShown ? '' : 'none'; };
$('activity-files').onclick = () => { if (!sidebarShown) $('toggle-sidebar').click(); $('file-search').classList.add('hidden'); renderTree(); };
$('activity-search').onclick = () => { if (!sidebarShown) $('toggle-sidebar').click(); $('file-search').classList.remove('hidden'); $('file-filter').focus(); };
$('file-filter').oninput = () => renderTree(($('file-filter') as HTMLInputElement).value);
$('activity-outline').onclick = () => { if (!sidebarShown) $('toggle-sidebar').click(); $('outline').classList.add('flash'); setTimeout(() => $('outline').classList.remove('flash'), 1200); };
$('toggle-bottom').onclick = () => { bottomShown = !bottomShown; $('bottom-panels').classList.toggle('hidden', !bottomShown); document.documentElement.style.setProperty('--bottom', bottomShown ? '252px' : '0px'); };
$('local-info').onclick = () => toast('项目目录：' + root);
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); sourceToggle.click(); return; } if (e.key === 'Escape') closeModal(); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); showPalette(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveAll(); } });
window.addEventListener('beforeunload', e => { if (!anyDirty()) return; try { localStorage.setItem('sidex-latex-draft:' + root, JSON.stringify(Object.fromEntries(getFiles().filter(f => isDirty(f.name)).map(f => [f.name, { base: saved.get(f.name), content: f.content }])))); } catch {} e.preventDefault(); e.returnValue = ''; });

async function boot() {
  try {
    const projectId=new URLSearchParams(location.search).get('project');
    const session = await fetch('/__latex/session'+(projectId?'?project='+encodeURIComponent(projectId):'')).then(r => r.json()); if (!session.token) throw Error('本地服务未就绪。'); token = session.token;
    await api<ModelSettings>('model-settings').then(applyModelSettings).catch(() => {});
    $('shell-label').textContent = session.pty ? 'PowerShell · PTY' : 'PowerShell · 按行执行';
    await loadProject(await api('project'));
    requestAnimationFrame(() => fit.fit());
    if (main) {
      const runtime = await api('realtime-status');
      const preference = localStorage.getItem('sidex-latex-live-v2:' + root);
      if (runtime.installed && runtime.texlive && preference !== 'false' && supportsLiveEditing()) await enableRealtime();
      else void compile();
    }
  } catch (e: any) { toast('工作区启动失败：' + e.message, true); $('compile-state').textContent = '服务未连接'; }
}
void boot();
