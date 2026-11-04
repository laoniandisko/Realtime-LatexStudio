using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// A process-local TeX prelude. Inherited byte handles preserve named-pipe/stdin
// protocols; a kill-on-close job also owns descendants when this runner is killed.
internal static class SideXLaTeXRunner {
  const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x100, KILL_ON_JOB_CLOSE = 0x2000;
  const string Prelude = @"\ifdefined\pdfpagewidth\else\let\pdfpagewidth\pagewidth\fi\ifdefined\pdfpageheight\else\let\pdfpageheight\pageheight\fi";
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public uint cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Inherit(int kind) { IntPtr result; var self=GetCurrentProcess(); Check(DuplicateHandle(self, GetStdHandle(kind), self, out result, 0, true, 2)); return result; }
  static string Quote(string value) {
    var text=new StringBuilder("\""); int slashes=0;
    foreach (char c in value) { if (c=='\\') { slashes++; continue; } if (c=='\"') { text.Append('\\', slashes*2+1).Append(c); slashes=0; continue; } text.Append('\\',slashes).Append(c); slashes=0; }
    return text.Append('\\',slashes*2).Append('"').ToString();
  }
  static string Input(string file) {
    // File names are data, not TeX source: keep %, braces and Unicode out of
    // the command-line token stream while preserving the original job name.
    var bytes=Encoding.UTF8.GetBytes(file.Replace('\\','/'));
    var text=new StringBuilder(@"\input{\directlua{tex.sprint(-2,string.char(");
    for(int i=0;i<bytes.Length;i++) { if(i>0)text.Append(','); text.Append(bytes[i]); }
    return text.Append("))}}").ToString();
  }
  static string[] Arguments(string[] args) {
    // --version/--help have no TeX input and must remain unchanged.
    if (args.Length==0 || args[args.Length-1].StartsWith("-",StringComparison.Ordinal)) return args;
    var input=args[args.Length-1]; bool command=input.StartsWith("\\",StringComparison.Ordinal), jobname=false;
    foreach(var arg in args)if(arg.Equals("-jobname",StringComparison.OrdinalIgnoreCase)||arg.Equals("--jobname",StringComparison.OrdinalIgnoreCase)||arg.StartsWith("-jobname=",StringComparison.OrdinalIgnoreCase)||arg.StartsWith("--jobname=",StringComparison.OrdinalIgnoreCase))jobname=true;
    bool insertJob=!command&&!jobname;
    var result=new string[args.Length+(insertJob?1:0)]; Array.Copy(args,0,result,0,args.Length-1);
    // NFSS can open an .fd file before the actual driver. Lock in the name that
    // LuaLaTeX would have derived from its original file argument first.
    if(insertJob)result[result.Length-2]="--jobname="+Path.GetFileNameWithoutExtension(input);
    var prefix=Prelude+(Environment.GetEnvironmentVariable("SIDEX_RTEX_LEGACY_OT1")=="1"?@"\def\encodingdefault{OT1}\fontencoding{OT1}\selectfont":"");
    result[result.Length-1]=prefix+(command?input:Input(input));
    return result;
  }
  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero, input=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero;
    ProcessInformation child=new ProcessInformation(); bool started=false;
    try {
      string executable=File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"lualatex.path"),Encoding.UTF8).Trim();
      var command=new StringBuilder(Quote(executable)); foreach(var arg in Arguments(args)) command.Append(' ').Append(Quote(arg));
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      var limits=new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags=KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      input=Inherit(-10); output=Inherit(-11); error=Inherit(-12);
      var startup=new StartupInfo(); startup.cb=(uint)Marshal.SizeOf(typeof(StartupInfo)); startup.dwFlags=STARTF_USESTDHANDLES; startup.hStdInput=input; startup.hStdOutput=output; startup.hStdError=error;
      Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out child)); started=true;
      Check(AssignProcessToJobObject(job,child.hProcess));
      if(ResumeThread(child.hThread)==UInt32.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error());
      if(WaitForSingleObject(child.hProcess,UInt32.MaxValue)!=0)throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code; Check(GetExitCodeProcess(child.hProcess,out code)); return unchecked((int)code);
    } catch(Exception exception) { if(started && child.hProcess!=IntPtr.Zero)TerminateProcess(child.hProcess,1); Console.Error.WriteLine("SideX LuaLaTeX runner: "+exception.Message); return 1; }
    finally { foreach(var handle in new[]{child.hThread,child.hProcess,input,output,error,job})if(handle!=IntPtr.Zero)CloseHandle(handle); }
  }
}
