param(
    [Parameter(Mandatory = $true)][int]$ProcessId
)
# 查询宿主进程里「鼠标穿透捕获窗」的窗口区域，输出 JSON。
#
# 为什么查区域而不是模拟点击：门禁要确定、可重复，而且不该挪用户的鼠标。区域就是命中测试本身
# （SetWindowRgn 的语义），所以「中心点不在区域内」等价于「点击会穿到下层」，「齿轮点在区域内」
# 等价于「热区可点」。这比派发合成事件更接近真实行为，也不受窗口焦点影响。
#
# 识别捕获窗：它是宿主进程里的另一个顶层窗口，带 WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
# （见 TransparencyInputCatcher.CreateParams），尺寸与主窗一致。
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class RegionProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int x1, int y1, int x2, int y2);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
    [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr hRgn, out RECT r);
    [DllImport("gdi32.dll")] public static extern int PtInRegion(IntPtr hRgn, int x, int y);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x00080000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;

    public class Info {
        public long hwnd;
        public int width;
        public int height;
        public bool visible;
        public bool layered;
        public bool toolwindow;
        public bool noactivate;
        public int regionKind;
        public int regionLeft, regionTop, regionRight, regionBottom;
        public string centreInside;
        public string gearInside;
        public string playerButtonInside;
    }

    // 区域查询：kind 0 = 无区域（整窗可命中）；1 = NULLREGION；2 = SIMPLEREGION；3 = COMPLEXREGION
    public static Info Describe(IntPtr hWnd) {
        Info i = new Info();
        i.hwnd = hWnd.ToInt64();
        RECT r; GetWindowRect(hWnd, out r);
        i.width = r.Right - r.Left; i.height = r.Bottom - r.Top;
        i.visible = IsWindowVisible(hWnd);
        long ex = GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64();
        i.layered = (ex & WS_EX_LAYERED) != 0;
        i.toolwindow = (ex & WS_EX_TOOLWINDOW) != 0;
        i.noactivate = (ex & WS_EX_NOACTIVATE) != 0;

        IntPtr rgn = CreateRectRgn(0, 0, 0, 0);
        try {
            i.regionKind = GetWindowRgn(hWnd, rgn);
            RECT box; GetRgnBox(rgn, out box);
            i.regionLeft = box.Left; i.regionTop = box.Top;
            i.regionRight = box.Right; i.regionBottom = box.Bottom;
            // 三个探针点都用**客户区坐标**（PtInRegion 对窗口区域用的就是它）。
            i.centreInside = PtInRegion(rgn, i.width / 2, i.height / 2) != 0 ? "yes" : "no";
            // 右上齿轮：right 24 / top 24 / 40x40（app.css）
            i.gearInside = PtInRegion(rgn, i.width - 44, 44) != 0 ? "yes" : "no";
            // 右下圆钮：right 32 / bottom 56 / 40x40
            i.playerButtonInside = PtInRegion(rgn, i.width - 52, i.height - 76) != 0 ? "yes" : "no";
        } finally { DeleteObject(rgn); }
        return i;
    }

    public static List<Info> ForProcess(int pid) {
        List<Info> list = new List<Info>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint wpid; GetWindowThreadProcessId(hWnd, out wpid);
            if (wpid != (uint)pid) return true;
            list.Add(Describe(hWnd));
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@

$all = [RegionProbe]::ForProcess($ProcessId)
# 捕获窗 = 同进程里带 LAYERED+TOOLWINDOW+NOACTIVATE 的那个顶层窗口
$catcher = $all | Where-Object { $_.layered -and $_.toolwindow -and $_.noactivate } | Select-Object -First 1
$result = @{
    windows = @($all | ForEach-Object {
        @{
            hwnd = $_.hwnd; width = $_.width; height = $_.height; visible = $_.visible
            layered = $_.layered; toolwindow = $_.toolwindow; noactivate = $_.noactivate
            regionKind = $_.regionKind
            regionBox = "$($_.regionLeft),$($_.regionTop),$($_.regionRight),$($_.regionBottom)"
            centreInside = $_.centreInside; gearInside = $_.gearInside
            playerButtonInside = $_.playerButtonInside
        }
    })
    catcher = if ($catcher) {
        @{
            hwnd = $catcher.hwnd; width = $catcher.width; height = $catcher.height
            regionKind = $catcher.regionKind
            regionBox = "$($catcher.regionLeft),$($catcher.regionTop),$($catcher.regionRight),$($catcher.regionBottom)"
            centreInside = $catcher.centreInside; gearInside = $catcher.gearInside
            playerButtonInside = $catcher.playerButtonInside
        }
    } else { $null }
}
$result | ConvertTo-Json -Depth 6 -Compress
