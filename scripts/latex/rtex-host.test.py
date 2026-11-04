import importlib.util,pathlib,threading,types,unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('rtex_host',pathlib.Path(__file__).with_name('rtex-host.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Native:
 def __init__(self):self.calls=[]
 def session_pause_background(self,session,value):self.calls.append(('pause',value))
 def session_request_layout(self,session):self.calls.append(('layout',))
 def session_export_pdf(self,session,path):self.calls.append(('export',path));return 7

class Scheduler(unittest.TestCase):
 def host(self):
  h=m.Host.__new__(m.Host);h.args=types.SimpleNamespace(auto_debounce_ms=300)
  h.native=Native();h.session=1;h.gate=threading.Lock();h.stop=threading.Event();h.latest=1;h.layout=1;h.started=True;h.needed=False;h.native_pending=False;h.native_pending_revision=0;h.edit_at=0;h.due=None;h.explicit=0;h.released=0;h.inflight=False
  return h
 def event(self,revision,ok=True):return {'event':'LayoutUpdate','versions':{'source_revision':revision},'compile':{'state':'Ok' if ok else 'Failed'}}
 def test_explicit_requests_release_immediately_and_coalesce_while_pending(self):
  h=self.host();h.latest=2;h.request();h.request();self.assertEqual(h.native.calls,[('pause',False),('layout',)]);self.assertEqual(h.explicit,2)
  h.event_state(self.event(2));h.native.calls.clear();h.request();self.assertEqual(h.native.calls,[('pause',False),('layout',)])
 def test_fast_same_height_edits_still_get_one_authoritative_quiet_time_pass(self):
  h=self.host()
  with patch.object(m.time,'monotonic',return_value=10):h.begin_edit();h.after_edit({'source_revision':2,'routed':'fast','outcome':{}})
  self.assertTrue(h.needed);self.assertFalse(h.native_pending);self.assertAlmostEqual(h.due,10.3)
 def test_automatic_requests_wait_for_quiet_and_do_not_duplicate_native_pending(self):
  h=self.host();h.latest=2;h.needed=True;h.due=10;h.native_pending=True
  with patch.object(m.time,'monotonic',return_value=9.99):h.auto_tick()
  self.assertEqual(h.native.calls,[])
  with patch.object(m.time,'monotonic',return_value=10):h.auto_tick()
  self.assertEqual(h.native.calls,[('pause',False)]);h.auto_tick();self.assertEqual(len(h.native.calls),1)
 def test_later_typing_does_not_inherit_old_explicit_request(self):
  h=self.host();h.latest=2;h.request()
  with patch.object(m.time,'monotonic',return_value=20):h.begin_edit();h.after_edit({'source_revision':3,'routed':'fast'})
  h.native.calls.clear()
  with patch.object(m.time,'monotonic',return_value=20.1):h.event_state(self.event(2))
  self.assertEqual(h.explicit,0);self.assertEqual(h.native.calls,[('pause',True)]);self.assertAlmostEqual(h.due,20.3)
  with patch.object(m.time,'monotonic',return_value=20.2):h.auto_tick()
  self.assertEqual(len(h.native.calls),1)
  with patch.object(m.time,'monotonic',return_value=20.31):h.auto_tick()
  self.assertEqual(h.native.calls[-2:],[('pause',False),('layout',)])
 def test_newer_explicit_revision_flushes_after_older_snapshot(self):
  h=self.host();h.latest=2;h.request();h.latest=3;h.native_pending=True;h.request();h.native.calls.clear();h.event_state(self.event(2))
  self.assertEqual(h.explicit,3);self.assertEqual(h.native.calls,[('pause',True),('pause',False),('layout',)])
 def test_old_layout_keeps_a_known_queued_newer_native_pass_for_resume(self):
  h=self.host();h.latest=2;h.request();h.latest=3;h.native_pending=True;h.native_pending_revision=3;h.edit_at=20
  with patch.object(m.time,'monotonic',return_value=20):h.event_state(self.event(2))
  self.assertTrue(h.native_pending);h.native.calls.clear()
  with patch.object(m.time,'monotonic',return_value=21):h.auto_tick()
  self.assertEqual(h.native.calls,[('pause',False)])
 def test_late_old_paragraph_does_not_schedule_another_complete_pass(self):
  h=self.host();h.event_state({'event':'ParagraphUpdate','versions':{'source_revision':1},'pagination_stale':True});self.assertFalse(h.needed);self.assertEqual(h.native.calls,[])
 def test_latest_failure_stops_automatic_retry_loop(self):
  h=self.host();h.latest=2;h.request();h.event_state(self.event(2,False));self.assertFalse(h.needed);self.assertIsNone(h.due);self.assertEqual(h.explicit,0)
 def test_export_does_not_resume_an_unnecessary_pass(self):
  h=self.host();self.assertEqual(h.command({'cmd':'export_pdf','out':'x.pdf'}),{'reply':'export_pdf','job_id':7});self.assertEqual(h.native.calls,[('export',b'x.pdf')])
 def test_invalid_protocol_types_never_reach_the_native_text_api(self):
  h=self.host();self.assertIn('error',h.command({'cmd':'edit','path':4})['reply']);self.assertIn('error',h.command({'cmd':'set_document','text':4})['reply']);self.assertIn('error',h.command({'cmd':'edit','start':True})['reply']);self.assertIn('error',h.command({'cmd':'edit','start':-1})['reply'])
 def test_abi_version_mismatch_fails_before_binding_any_session_function(self):
  class Version:
   def __call__(self):return b'0.0.5'
  lib=types.SimpleNamespace(rtex_version=Version())
  with patch.object(m.C,'CDLL',return_value=lib),patch.object(m.os,'add_dll_directory',create=True):
   with self.assertRaisesRegex(RuntimeError,'Unsupported realtime-tex ABI version'):m.Native(pathlib.Path(__file__))
 def test_embedded_nulls_never_truncate_source_or_paths_in_the_c_abi(self):
  h=self.host();self.assertEqual(h.command({'cmd':'set_document','text':'x\x00y'})['reply'],'error');self.assertEqual(h.command({'cmd':'spans','path':'x\x00y'})['reply'],'error');self.assertEqual(h.native.calls,[])
 def test_errors_are_bounded_single_line(self):
  self.assertEqual(m.bounded_error(Exception('x'*10000)), 'x'*1024);self.assertEqual(m.bounded_error(Exception('a\nb\rc')),'a b c')

if __name__=='__main__':unittest.main()
