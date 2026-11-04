"""JSON-lines host for realtime-tex 0.0.6. Uses only Python standard library.

Native background debounce is zero. This host retains a quiet-time gate for
automatic pagination while explicit layout/export requests can start at once.
"""
import argparse,ctypes as C,json,os,pathlib,queue,re,sys,threading,time

MAX_LINE=24*1024*1024

def bounded_error(error):
 return str(error).replace("\r"," ").replace("\n"," ")[:1024]

class Native:
 def __init__(self,dll):
  dll=dll.resolve()
  self.directory=os.add_dll_directory(str(dll.parent)) if os.name=='nt' else None
  self.lib=C.CDLL(str(dll));P=C.c_void_p;S=C.c_char_p;Z=C.c_size_t
  self.lib.rtex_version.argtypes=[];self.lib.rtex_version.restype=S
  version=self.lib.rtex_version().decode("ascii","replace")
  if version!="0.0.6":raise RuntimeError("Unsupported realtime-tex ABI version: "+version[:40])
  def bind(name,args,result):
   f=getattr(self.lib,name);f.argtypes=args;f.restype=result;setattr(self,name.removeprefix('rtex_'),f)
  for name,args,result in [('session_open',[S,C.POINTER(P)],P),('session_close',[P],None),('session_poll',[P,C.c_uint32],P),('session_apply_edit',[P,S,Z,Z,S],P),('session_set_document',[P,S,S],P),('session_request_layout',[P],None),('session_pause_background',[P,C.c_bool],None),('session_export_pdf',[P,S],C.c_uint64),('session_status',[P],P),('session_spans',[P,S],P),('event_json',[P],P),('event_kind',[P],C.c_uint32),('event_dl_count',[P],C.c_uint32),('event_dl',[P,C.c_uint32,C.POINTER(Z)],P),('event_free',[P],None),('dl_to_json',[P,Z],P),('string_free',[P],None)]:bind('rtex_'+name,args,result)
 def owned(self,p):
  if not p:raise RuntimeError('Native call returned null')
  try:return C.string_at(p)
  finally:self.string_free(p)

class Host:
 def __init__(self,args):
  self.args=args;self.native=Native(pathlib.Path(args.library));self.output_lock=threading.Lock();self.gate=threading.Lock();self.stop=threading.Event();self.latest=1;self.layout=0;self.started=False;self.needed=False;self.native_pending=False;self.native_pending_revision=0;self.edit_at=0.;self.due=None;self.explicit=0;self.released=0;self.inflight=False;self.input=queue.Queue(maxsize=32);self.failure=None
  error=C.c_void_p();config={'project_root':str(pathlib.Path(args.project).resolve()),'main_file':args.main,'build_dir':str(pathlib.Path(args.build).resolve()),'debounce_ms':args.debounce_ms,'fast_budget_ms':args.fast_budget_ms,'eligibility':args.eligibility,'picture_cache':args.picture_cache}
  if args.debug_dir:config['debug_dir']=args.debug_dir
  self.session=self.native.session_open(json.dumps(config,ensure_ascii=False).encode(),C.byref(error))
  if not self.session:raise RuntimeError(self.native.owned(error.value).decode() if error.value else 'Could not open session')
  self.poller=threading.Thread(target=self.events,name='rtex-events',daemon=True);self.scheduler=threading.Thread(target=self.automatic,name='rtex-automatic',daemon=True);self.reader=threading.Thread(target=self.read_input,name='rtex-input',daemon=True)
 def emit(self,data):
  if not isinstance(data,bytes):data=json.dumps(data,separators=(',',':'),ensure_ascii=False).encode()
  with self.output_lock:sys.stdout.buffer.write(data+b'\n');sys.stdout.buffer.flush()
 def begin_edit(self):
  with self.gate:
   if self.started:self.native.session_pause_background(self.session,True)
   self.edit_at=time.monotonic();self.due=self.edit_at+self.args.auto_debounce_ms/1000
 def after_edit(self,result):
  with self.gate:
   self.latest=max(self.latest,result.get('source_revision',1))
   # Counter changes can schedule a native pass without a stale/reason flag in
   # ParagraphUpdate. Every accepted revision gets one quiet-time confirmation.
   self.needed=self.needed or self.latest>self.layout
   if result.get('routed')!='fast' or result.get('outcome',{}).get('added') or result.get('outcome',{}).get('removed'):self.needed=True;self.native_pending=True;self.native_pending_revision=self.latest
 def request(self):
  with self.gate:
   self.explicit=max(self.explicit,self.latest);self.needed=True;self.due=None
   if self.released>=self.latest or self.inflight:return
   self.released=self.latest;self.inflight=True
   self.native.session_pause_background(self.session,False)
   if not self.native_pending:self.native.session_request_layout(self.session)
   self.native_pending=True
 def automatic(self):
  while not self.stop.wait(.005):self.auto_tick()
 def auto_tick(self):
  with self.gate:
   if not self.started or not self.needed or self.due is None or time.monotonic()<self.due or self.layout>=self.latest or self.inflight:return
   self.due=None;self.released=self.latest;self.inflight=True;self.native.session_pause_background(self.session,False)
   if not self.native_pending:self.native.session_request_layout(self.session)
   self.native_pending=True
 def event_state(self,event):
  with self.gate:
   name=event.get('event')
   if name=='LayoutUpdate':
    self.started=True;self.inflight=False;revision=event.get('versions',{}).get('source_revision',0)
    success=event.get('compile',{}).get('state')=='Ok'
    if success:self.layout=max(self.layout,revision)
    if revision>=self.released:self.released=0
    # A manual request belongs to the revision requested. A completed older
    # request must never give later automatic edits a permanent fast lane.
    if self.explicit and revision>=self.explicit:self.explicit=0
    self.native.session_pause_background(self.session,True)
    self.native_pending=self.native_pending and self.native_pending_revision>revision
    if not self.native_pending:self.native_pending_revision=0
    if self.layout>=self.latest or not success and revision>=self.latest:
     self.needed=False;self.due=None;self.explicit=0
    elif self.explicit>revision:
     # A newer explicit request arrived while this snapshot was running.
     self.needed=True;self.released=0;self.release_explicit_locked()
    else:
     self.needed=True;self.due=max(time.monotonic(),self.edit_at+self.args.auto_debounce_ms/1000)
   elif name=='BackgroundScheduled' or name=='ParagraphUpdate' and (event.get('pagination_stale') or event.get('context_stale') or event.get('reasons')):
    revision=event.get('versions',{}).get('source_revision',self.latest)
    if revision<=self.layout:return
    self.needed=True;self.native_pending=True;self.native_pending_revision=max(self.native_pending_revision,revision)
    if not self.explicit and self.due is None:self.due=max(time.monotonic(),self.edit_at+self.args.auto_debounce_ms/1000)
 def release_explicit_locked(self):
  self.released=self.latest;self.inflight=True;self.due=None
  self.native.session_pause_background(self.session,False)
  if not self.native_pending:self.native.session_request_layout(self.session)
  self.native_pending=True
 def events(self):
  # The C ABI blocks without holding the source-edit path's locks. No Python lock
  # is held across poll; edits do not wait for this 10ms native receive timeout.
  try:
   while not self.stop.is_set():
    event=self.native.session_poll(self.session,10)
    if not event:continue
    try:
     raw=C.string_at(self.native.event_json(event));metadata=json.loads(raw);self.event_state(metadata)
     count=self.native.event_dl_count(event)
     if count:
      displays=[]
      for index in range(count):
       length=C.c_size_t();data=self.native.event_dl(event,index,C.byref(length));displays.append(self.native.owned(self.native.dl_to_json(data,length.value)))
      index=0
      def replace(match):
       nonlocal index
       if index>=len(displays):raise RuntimeError('Display-list count mismatch')
       value=b'"dl":'+displays[index];index+=1;return value
      raw=re.sub(rb'"dl":\s*\{\s*"bytes"\s*:\s*\d+(?:\s*,\s*"index"\s*:\s*\d+)?\s*\}',replace,raw)
      if index!=count:raise RuntimeError('Display-list placeholders changed')
     self.emit(raw)
    finally:self.native.event_free(event)
  except Exception as error:
   self.failure=error
   sys.stderr.write('rtex-host event failure: '+bounded_error(error)+'\n');sys.stderr.flush();self.stop.set()
 def command(self,value):
  command=value.get('cmd','');path=value.get('path','main.tex')
  if not isinstance(path,str) or '\x00' in path:return {'reply':'error','message':'Invalid source path'}
  path=path.encode()
  if command in ['edit','set_document'] and (not isinstance(value.get('text',''),str) or '\x00' in value.get('text','')):return {'reply':'error','message':'Invalid source text'}
  if command=='edit':
   start=value.get('start',0);end=value.get('end',0)
   if type(start) is not int or type(end) is not int or start<0 or end<0:return {'reply':'error','message':'Invalid byte offset'}
  if command in ['edit','set_document']:
   self.begin_edit()
   if command=='edit':
    raw=self.native.owned(self.native.session_apply_edit(self.session,path,start,end,value.get('text','').encode()))
   else:raw=self.native.owned(self.native.session_set_document(self.session,path,value.get('text','').encode()))
   result=json.loads(raw)
   if 'error' in result:return {'reply':'error','message':result['error']}
   self.after_edit(result);return b'{"reply":"'+command.encode()+b'","result":'+raw+b'}'
  if command=='spans':return b'{"reply":"spans","spans":'+self.native.owned(self.native.session_spans(self.session,path))+b'}'
  if command=='status':return b'{"reply":"status",'+self.native.owned(self.native.session_status(self.session)).lstrip()[1:]
  if command=='request_layout':self.request();return {'reply':'request_layout'}
  if command=='export_pdf':
   # Export is its own native background command and bypasses the paused-Pass
   # gate. Resuming here could queue an unnecessary full pass before the export.
   return {'reply':'export_pdf','job_id':self.native.session_export_pdf(self.session,value.get('out','out.pdf').encode())}
  if command=='pause_background':
   with self.gate:self.native.session_pause_background(self.session,bool(value.get('paused',True)))
   return {'reply':'pause_background'}
  if command=='quit':return None
  return {'reply':'error','message':'Unknown or unsupported C ABI command: '+command}
 def read_input(self):
  # Read the raw descriptor, not BufferedReader, so a daemon blocked on an open
  # pipe does not retain a Python buffered-I/O lock when a quit command exits.
  pending=b''
  try:
   while not self.stop.is_set():
    chunk=os.read(sys.stdin.fileno(),65536)
    if not chunk:break
    pending+=chunk
    if len(pending)>MAX_LINE and b'\n' not in pending:raise ValueError('Input line exceeds 24 MiB')
    while b'\n' in pending:
     line,pending=pending.split(b'\n',1)
     if len(line)>MAX_LINE:raise ValueError('Input line exceeds 24 MiB')
     if line.strip():self.input.put(line)
   if pending.strip():self.input.put(pending)
  except Exception as error:self.input.put(error)
  finally:self.input.put(None)
 def run(self):
  self.poller.start();self.scheduler.start();self.reader.start()
  try:
   while not self.stop.is_set():
    try:line=self.input.get(timeout=.05)
    except queue.Empty:continue
    if line is None:break
    if isinstance(line,Exception):raise line
    try:
     value=json.loads(line)
     if not isinstance(value,dict):raise ValueError('Command must be an object')
     if value.get('cmd')=='quit':break
     self.emit(self.command(value))
    except Exception as error:self.emit({'reply':'error','message':bounded_error(error)})
  finally:
   self.stop.set();self.poller.join();self.scheduler.join();self.native.session_close(self.session)
  if self.failure:raise RuntimeError('Native event stream failed')

def main():
 repo=pathlib.Path(__file__).resolve().parents[2];dist=repo/'.runtime/rtex/bin/rtex-0.0.6-x86_64-pc-windows-msvc';p=argparse.ArgumentParser();p.add_argument('command',choices=['serve'],nargs='?',default='serve');p.add_argument('--probe',action='store_true');p.add_argument('--project');p.add_argument('--main',default='main.tex');p.add_argument('--build');p.add_argument('--library','--dll',dest='library',default=str(dist/'lib/rtex_core.dll'));p.add_argument('--debounce-ms',type=int,default=0);p.add_argument('--auto-debounce-ms',type=int,default=300);p.add_argument('--fast-budget-ms',type=int,default=50);p.add_argument('--eligibility',default='probe');p.add_argument('--picture-cache',action=argparse.BooleanOptionalAction,default=True);p.add_argument('--debug-dir');args=p.parse_args()
 if args.probe:
  Native(pathlib.Path(args.library));print(json.dumps({'version':'0.0.6','host':'ctypes-json'}));return
 if not args.project or not args.build:p.error('--project and --build are required for serve')
 if args.debounce_ms<0 or args.auto_debounce_ms<0:p.error('Debounce values must be non-negative')
 os.environ.setdefault('RTEX_TEXDIR',str(dist/'share/rtex/tex'));Host(args).run()
if __name__=='__main__':
 try:main()
 except Exception as error:
  sys.stderr.write('rtex-host failure: '+bounded_error(error)+'\n');sys.stderr.flush();sys.exit(1)
