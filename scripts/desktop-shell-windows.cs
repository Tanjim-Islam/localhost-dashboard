using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// A test-only observer for the dashboard window. Desktop-wide input is restricted
// to a disposable runner. All window operations select the exact launched PID.
internal static class DashboardShellCheck {
    delegate bool WindowProc(IntPtr handle, IntPtr unused);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
    [StructLayout(LayoutKind.Sequential)] struct TrayIdentifier {
        public uint size; public IntPtr window; public uint id; public Guid guid;
    }
    [DllImport("user32")] static extern bool EnumWindows(WindowProc callback,IntPtr unused);
    [DllImport("user32",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
    [DllImport("user32",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int count);
    [DllImport("user32")] static extern bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
    [DllImport("user32")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32")] static extern bool GetWindowRect(IntPtr h,out Rect rect);
    [DllImport("user32")] static extern bool ShowWindow(IntPtr h,int state);
    [DllImport("user32")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32")] static extern bool SetProcessDPIAware();
    [DllImport("user32")] static extern bool GetCursorPos(out Point p);
    [DllImport("user32",CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls,string title);
    [DllImport("user32",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls,string title);
    [DllImport("user32")] static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
    [DllImport("shell32")] static extern int Shell_NotifyIconGetRect(ref TrayIdentifier item,out Rect rect);
    [DllImport("user32")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32")] static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32")] static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    [DllImport("user32")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
    static bool Hosted {
        get {return Environment.GetEnvironmentVariable("GITHUB_ACTIONS")=="true"
            && Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")=="github-hosted";}
    }

    static IntPtr Dashboard(uint processId) {
        IntPtr target=IntPtr.Zero;
        EnumWindows((h,u) => {
            uint id; GetWindowThreadProcessId(h,out id);
            if(id!=processId) return true;
            var title=new StringBuilder(256); GetWindowText(h,title,title.Capacity);
            if(title.ToString()!="Localhost Dashboard") return true;
            target=h; return false;
        },IntPtr.Zero);
        if(target==IntPtr.Zero) throw new Exception("Dashboard window for fixture PID was not found.");
        return target;
    }

    static bool HasTaskbar() { return FindWindow("Shell_TrayWnd",null)!=IntPtr.Zero; }

    static void OpenTrayOverflow() {
        if(!Hosted) return;
        var visibleOverflow=FindWindow("NotifyIconOverflowWindow",null);
        if(visibleOverflow!=IntPtr.Zero && IsWindowVisible(visibleOverflow)) return;
        var taskbar=FindWindow("Shell_TrayWnd",null);
        var area=FindWindowEx(taskbar,IntPtr.Zero,"TrayNotifyWnd",null);
        if(area==IntPtr.Zero) return;
        var chevron=FindWindowEx(area,IntPtr.Zero,"Button",null);
        if(chevron==IntPtr.Zero) return;
        IntPtr result;
        // Expose the hidden notification icons as a user would on Windows Server.
        SendMessageTimeout(chevron,0x00F5,IntPtr.Zero,IntPtr.Zero,2,1000,out result);
    }

    static void PrepareDesktop() {
        Point p;
        if(Hosted && !HasTaskbar()) {
            var start=new ProcessStartInfo(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe"));
            start.UseShellExecute=false; start.WindowStyle=ProcessWindowStyle.Hidden;
            using(var explorer=Process.Start(start)) {
                for(int i=0;i<50 && !HasTaskbar();i++) Thread.Sleep(200);
            }
        }
        Console.WriteLine("{0} {1}",GetCursorPos(out p) ? "cursor" : "no-cursor",HasTaskbar() ? "taskbar" : "no-taskbar");
    }

    [STAThread]
    static int Main(string[] args) {
        try {
            SetProcessDPIAware();
            if(args[0]=="desktop") { PrepareDesktop(); return 0; }
            if(args[0]=="record-uri") {
                var receipt=System.IO.Path.GetFullPath(args[1]);
                var directory=System.IO.Path.GetDirectoryName(receipt);
                // Explorer launches URL handlers with its own environment. Bind the
                // receipt to this generated helper and its own temporary directory.
                var executable=System.Reflection.Assembly.GetEntryAssembly().Location;
                if(System.IO.Path.GetFileName(receipt)!="received-uri.txt"
                    || !System.IO.Path.GetFileName(directory).StartsWith("dashboard-shell-")
                    || !String.Equals(System.IO.Path.GetDirectoryName(executable),directory,StringComparison.OrdinalIgnoreCase)
                    || !String.Equals(System.IO.Directory.GetParent(directory).FullName,System.IO.Path.GetTempPath().TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))
                    throw new Exception("Invalid fixture path.");
                System.IO.File.WriteAllText(receipt,args[2]);
                return 0;
            }
            var h=Dashboard(uint.Parse(args[0]));
            var action=args[1];
            if(action=="state") {
                Rect r; if(!GetWindowRect(h,out r)) throw new Exception("Cannot read window rectangle.");
                Console.WriteLine("{0} {1} {2} {3} {4}", IsWindowVisible(h)?1:0,IsIconic(h)?1:0,IsZoomed(h)?1:0,r.left,r.top);
                return 0;
            }
            if(action=="restore") {ShowWindow(h,9); SetForegroundWindow(h); return 0;}
            if(action=="same-image-dashboard-count") {
                if(!Hosted) throw new Exception("Installed instance checks require a disposable runner.");
                var image=Process.GetProcessById(int.Parse(args[0])).MainModule.FileName;
                int count=0;
                EnumWindows((handle,data)=>{
                    var title=new StringBuilder(256); GetWindowText(handle,title,title.Capacity);
                    if(title.ToString()!="Localhost Dashboard") return true;
                    uint owner; GetWindowThreadProcessId(handle,out owner);
                    using(var process=Process.GetProcessById((int)owner)) {
                        if(String.Equals(image,process.MainModule.FileName,StringComparison.OrdinalIgnoreCase)) count++;
                    }
                    return true;
                },IntPtr.Zero);
                Console.WriteLine(count); return 0;
            }
            if(action=="tray-callback") {
                // Deliver the same notification sent by Explorer on a left-button release.
                // The helper targets only the tray-icon 0.25 window of the fixture process.
                Point cursor;
                if(!HasTaskbar() || !GetCursorPos(out cursor)) {
                    Console.WriteLine("unavailable: taskbar="+HasTaskbar()+" cursor="+GetCursorPos(out cursor));
                    return 0;
                }
                bool found=false, sent=false; int firstResult=0; uint fixture=uint.Parse(args[0]);
                EnumWindows((handle,data)=>{
                    uint id; GetWindowThreadProcessId(handle,out id);
                    if(id!=fixture) return true;
                    var cls=new StringBuilder(64); GetClassName(handle,cls,cls.Capacity);
                    if(cls.ToString()!="tray_icon_app") return true;
                    found=true;
                    var item=new TrayIdentifier{size=(uint)Marshal.SizeOf(typeof(TrayIdentifier)),window=handle};
                    Rect rect;
                    for(uint iconId=1;iconId<8;iconId++){
                        item.id=iconId;
                        int result=Shell_NotifyIconGetRect(ref item,out rect);
                        if(iconId==1) firstResult=result;
                        if(result==0) {
                            sent=PostMessage(handle,6002,new IntPtr(iconId),new IntPtr(0x202));
                            break;
                        }
                    }
                    return false;
                },IntPtr.Zero);
                if(!found) throw new Exception("Fixture tray window not found.");
                if(!sent) OpenTrayOverflow();
                Console.WriteLine(sent ? "sent" : "Shell_NotifyIconGetRect returned 0x"+firstResult.ToString("X8"));
                return 0;
            }
            if(!Hosted) throw new Exception("Desktop-wide input requires a disposable Windows runner.");
            if(action=="clipboard-empty") return Clipboard.GetDataObject()==null || Clipboard.GetDataObject().GetFormats().Length==0 ? 0:1;
            if(action=="clipboard-matches") return Clipboard.GetText()==args[2] ? 0:1;
            if(action=="clear-clipboard") {if(Clipboard.GetText()==args[2]) Clipboard.Clear(); return 0;}
            if(action=="hotkey") {
                byte fKey=byte.Parse(args[2]); if(fKey<0x86 || fKey>0x87) throw new Exception("Use F23 or F24.");
                foreach(var key in new byte[]{0x11,0x12,0x10,fKey}) keybd_event(key,0,0,UIntPtr.Zero);
                Thread.Sleep(70);
                foreach(var key in new byte[]{fKey,0x10,0x12,0x11}) keybd_event(key,0,2,UIntPtr.Zero);
                return 0;
            }
            if(action!="drag" && action!="double") throw new Exception("Unknown window test action.");
            var p=new Point{x=int.Parse(args[2]),y=int.Parse(args[3])};
            Point original; GetCursorPos(out original);
            try {
                SetForegroundWindow(h);
                Thread.Sleep(150);
                ClientToScreen(h,ref p);
                if(GetAncestor(WindowFromPoint(p),2)!=h) throw new Exception("The fixture title bar is covered by another window.");
                SetCursorPos(p.x,p.y);
                mouse_event(2,0,0,0,UIntPtr.Zero); Thread.Sleep(75);
                if(action=="drag") {
                    for(int n=1;n<=8;n++) {SetCursorPos(p.x+6*n,p.y+3*n); Thread.Sleep(30);}
                    mouse_event(4,0,0,0,UIntPtr.Zero);
                } else {
                    mouse_event(4,0,0,0,UIntPtr.Zero); Thread.Sleep(65);
                    mouse_event(2,0,0,0,UIntPtr.Zero); Thread.Sleep(40); mouse_event(4,0,0,0,UIntPtr.Zero);
                }
                return 0;
            } finally {mouse_event(4,0,0,0,UIntPtr.Zero); SetCursorPos(original.x,original.y);}
        } catch(Exception err) {Console.Error.WriteLine(err.Message); return 1;}
    }
}
