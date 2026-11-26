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

    [STAThread]
    static int Main(string[] args) {
        try {
            SetProcessDPIAware();
            if(args[0]=="record-uri") {
                if(!Hosted) throw new Exception("URL dispatch fixture requires a disposable runner.");
                var receipt=System.IO.Path.GetFullPath(args[1]);
                var directory=System.IO.Path.GetDirectoryName(receipt);
                if(System.IO.Path.GetFileName(receipt)!="received-uri.txt"
                    || !System.IO.Path.GetFileName(directory).StartsWith("dashboard-shell-")
                    || System.IO.Directory.GetParent(directory).FullName!=System.IO.Path.GetTempPath().TrimEnd('\\'))
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
            if(action=="tray-callback") {
                // Deliver the same notification sent by Explorer on a left-button release.
                // The helper targets only the tray-icon 0.25 window of the fixture process.
                bool sent=false; uint fixture=uint.Parse(args[0]);
                EnumWindows((handle,data)=>{
                    uint id; GetWindowThreadProcessId(handle,out id);
                    if(id!=fixture) return true;
                    var cls=new StringBuilder(64); GetClassName(handle,cls,cls.Capacity);
                    if(cls.ToString()!="tray_icon_app") return true;
                    sent=PostMessage(handle,6002,IntPtr.Zero,new IntPtr(0x202));
                    return false;
                },IntPtr.Zero);
                if(!sent) throw new Exception("Fixture tray window not found.");
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
