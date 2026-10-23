$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.Flush()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class RabiAgentPresentation : ApplicationContext {
    public static string IconPath { get; set; }
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Icon windowIcon;
    readonly Icon trayIcon;
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Form window = new Form();
    readonly TextBox details = new TextBox();
    readonly ToolStripMenuItem state = new ToolStripMenuItem("正在启动");
    readonly ToolStripMenuItem start = new ToolStripMenuItem("启动连接器");
    readonly ToolStripMenuItem pause = new ToolStripMenuItem("停止连接器");
    readonly ToolStripMenuItem restart = new ToolStripMenuItem("重启连接器");
    readonly ToolStripMenuItem reconnect = new ToolStripMenuItem("重新连接主机");
    readonly ToolStripMenuItem manager = new ToolStripMenuItem("打开主机管理页");
    readonly ToolStripMenuItem startup = new ToolStripMenuItem("开机启动");
    readonly ToolStripMenuItem exit = new ToolStripMenuItem("退出 Rabi Agent");
    bool ownerAlive = true;

    public RabiAgentPresentation() {
        windowIcon = new Icon(IconPath);
        trayIcon = new Icon(windowIcon, SystemInformation.SmallIconSize);
        window.Icon = windowIcon;
        window.Text = "Rabi Agent · 状态与日志";
        window.Size = new Size(640, 480);
        window.StartPosition = FormStartPosition.CenterScreen;
        window.ShowInTaskbar = true;
        details.Multiline = true; details.ReadOnly = true;
        details.ScrollBars = ScrollBars.Vertical; details.Dock = DockStyle.Fill;
        details.Font = new Font("Microsoft YaHei UI", 10);
        window.Controls.Add(details);
        window.FormClosing += (s, e) => { if (ownerAlive) { e.Cancel = true; window.Hide(); } };
        var menu = new ContextMenuStrip();
        state.Enabled = false;
        menu.Items.Add(state);
        menu.Items.Add("状态与日志", null, (s, e) => { window.Show(); window.Activate(); });
        menu.Items.Add(new ToolStripSeparator());
        foreach (var item in new[] { start, pause, restart, reconnect, manager, startup, exit }) menu.Items.Add(item);
        start.Click += (s,e) => Send("start");
        pause.Click += (s,e) => Send("pause");
        restart.Click += (s,e) => Send("restart");
        reconnect.Click += (s,e) => Send("reconnect");
        manager.Click += (s,e) => Send("open-manager");
        startup.Click += (s,e) => Send("startup", !startup.Checked);
        exit.Click += (s,e) => Send("exit");
        tray.Icon = trayIcon; tray.Text = "Rabi Agent · 正在启动";
        tray.ContextMenuStrip = menu; tray.Visible = true;
        tray.DoubleClick += (s,e) => { window.Show(); window.Activate(); };
        // Create the dispatch handle before the reader can publish a snapshot.
        var handle = window.Handle;
        var reader = new Thread(ReadOwner); reader.IsBackground = true; reader.Start();
        Emit(new { type = "ready" });
    }
    void Emit(object value) { lock(json) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
    void Send(string action, bool enabled = false) { Emit(new { type = "command", action, enabled }); }
    void ReadOwner() {
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line.Length > 65536) break;
                Dictionary<string,object> data;
                lock(json) { data = json.Deserialize<Dictionary<string,object>>(line); }
                if (data == null || !data.ContainsKey("type") || Convert.ToString(data["type"]) != "snapshot") continue;
                window.BeginInvoke(new Action(() => Render(data)));
            }
        } catch { /* Pipe closure ends presentation; no fallback owner. */ }
        try { window.BeginInvoke(new Action(() => ExitThread())); } catch { }
    }
    string Text(Dictionary<string,object> data, string key) { return data.ContainsKey(key) ? Convert.ToString(data[key]) : ""; }
    bool Flag(Dictionary<string,object> data, string key) { return data.ContainsKey(key) && data[key] is bool && (bool)data[key]; }
    void Render(Dictionary<string,object> data) {
        state.Text = Text(data, "summary");
        var tooltip = "Rabi Agent · " + state.Text;
        tray.Text = tooltip.Length > 63 ? tooltip.Substring(0,63) : tooltip;
        bool running = Flag(data, "running");
        bool busy = Flag(data, "busy");
        start.Enabled = !running && !busy;
        pause.Enabled = running && !busy;
        restart.Enabled = running && !busy;
        reconnect.Enabled = running && !busy;
        manager.Enabled = Flag(data, "canOpenManager");
        startup.Checked = Flag(data, "startup");
        details.Text = Text(data, "details").Replace("\n", Environment.NewLine);
        Emit(new { type = "rendered", summary = state.Text, startup = startup.Checked, running, visible = tray.Visible });
    }
    protected override void ExitThreadCore() {
        ownerAlive = false; tray.Visible = false; tray.Dispose(); window.Dispose();
        trayIcon.Dispose(); windowIcon.Dispose(); base.ExitThreadCore();
    }
    [STAThread] public static void Run() { Application.EnableVisualStyles(); Application.Run(new RabiAgentPresentation()); }
}
'@
$nativeHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($nativeSource.Replace("`r`n", "`n")))).Replace('-', '').ToLowerInvariant()
$nativeAssembly = Join-Path $PSScriptRoot "../dist/native/tray-$nativeHash.dll"
if (Test-Path -LiteralPath $nativeAssembly) {
    Add-Type -Path $nativeAssembly
} else {
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition $nativeSource
}
[RabiAgentPresentation]::IconPath = Join-Path $PSScriptRoot 'rabi-agent.ico'
[RabiAgentPresentation]::Run()
