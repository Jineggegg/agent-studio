using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CloudHarness {
  // Fixed desktop primitives only. There is deliberately no shell, URL, script or clipboard API.
  public static class DesktopActions {
    [StructLayout(LayoutKind.Sequential)] private struct Mouse { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Key { public ushort code, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] private struct InputData { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Key key; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public InputData data; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder title, int count);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    private static IntPtr target;
    public static void Initialize() { SetProcessDPIAware(); }
    public static int Width { get { return Screen.PrimaryScreen.Bounds.Width; } }
    public static int Height { get { return Screen.PrimaryScreen.Bounds.Height; } }
    public static bool Confirm(string description, string origin) {
      target = GetForegroundWindow();
      var title = new StringBuilder(512); GetWindowText(target, title, title.Capacity);
      string message = "Cloud Harness at " + origin + " requests:\n\n" + description + "\n\nCurrent window: " + title + "\n\nAllow this one action?";
      using (var owner = new Form()) {
        owner.TopMost = true; owner.ShowInTaskbar = false; owner.Opacity = 0;
        owner.StartPosition = FormStartPosition.CenterScreen; owner.Show();
        var answer = MessageBox.Show(owner, message, "Cloud Harness — confirm on this computer", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        owner.Close();
        if (answer != DialogResult.Yes) { target = IntPtr.Zero; return false; }
      }
      SetForegroundWindow(target); Thread.Sleep(150);
      return true;
    }
    private static void RequireUnmodifiedKeyboard() {
      // Never release the user's keys or synthesize shortcuts around an action.
      foreach (int code in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
        if ((GetAsyncKeyState(code) & 0x8000) != 0) throw new InvalidOperationException("Release modifier keys first.");
    }
    private static void Send(Input[] input) {
      if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length)
        throw new InvalidOperationException("Windows did not accept all input events.");
    }
    public static void Click(int x, int y) {
      RequireUnmodifiedKeyboard();
      var bounds = Screen.PrimaryScreen.Bounds;
      if (x < 0 || y < 0 || x >= bounds.Width || y >= bounds.Height) throw new ArgumentOutOfRangeException();
      if (!SetCursorPos(bounds.Left + x, bounds.Top + y)) throw new InvalidOperationException("Cannot move pointer.");
      Send(new Input[] { new Input { type = 0, data = new InputData { mouse = new Mouse { flags = 0x0002 } } }, new Input { type = 0, data = new InputData { mouse = new Mouse { flags = 0x0004 } } } });
    }
    public static void TypeLiteral(string text) {
      if (text == null || text.Length == 0 || text.Length > 2000) throw new ArgumentOutOfRangeException();
      RequireUnmodifiedKeyboard();
      if (target == IntPtr.Zero || GetForegroundWindow() != target) throw new InvalidOperationException("Foreground window changed after local confirmation.");
      var inputs = new Input[text.Length * 2];
      for (int i = 0; i < text.Length; i++) {
        inputs[i * 2] = new Input { type = 1, data = new InputData { key = new Key { scan = text[i], flags = 0x0004 } } };
        inputs[i * 2 + 1] = new Input { type = 1, data = new InputData { key = new Key { scan = text[i], flags = 0x0004 | 0x0002 } } };
      }
      Send(inputs);
    }
    public static string Screenshot() {
      var bounds = Screen.PrimaryScreen.Bounds;
      if (bounds.Width > 32768 || bounds.Height > 32768 || (long)bounds.Width * bounds.Height > 40000000) throw new InvalidOperationException("Screen dimensions exceed the capture limit.");
      using (var full = new Bitmap(bounds.Width, bounds.Height)) {
        using (var graphics = Graphics.FromImage(full)) graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
        double ratio = Math.Min(1.0, 1600.0 / Math.Max(bounds.Width, bounds.Height));
        using (var scaled = new Bitmap(full, Math.Max(1, (int)(bounds.Width * ratio)), Math.Max(1, (int)(bounds.Height * ratio))))
        using (var stream = new MemoryStream()) {
          scaled.Save(stream, ImageFormat.Jpeg);
          if (stream.Length > 2 * 1024 * 1024) throw new InvalidOperationException("Screenshot exceeds the transfer limit.");
          return Convert.ToBase64String(stream.ToArray());
        }
      }
    }
  }
}
