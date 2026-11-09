using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PaperTranslationStudio
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            bool firstInstance;
            using (var mutex = new Mutex(true, @"Local\PaperTranslationStudio", out firstInstance))
            {
                if (!firstInstance)
                {
                    IntPtr existing = Native.FindWindow(null, "论文译读");
                    if (existing != IntPtr.Zero)
                    {
                        Native.ShowWindow(existing, 9);
                        Native.SetForegroundWindow(existing);
                    }
                    else
                    {
                        MessageBox.Show("论文译读正在启动，请稍候。", "论文译读");
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ReaderWindow());
            }
        }
    }

    internal sealed class ReaderWindow : Form
    {
        private readonly WebView2 view = new WebView2();
        private readonly Label loading = new Label();
        private Process backend;
        private IntPtr processJob;
        private Uri origin;

        public ReaderWindow()
        {
            Text = "论文译读";
            Width = 1480;
            Height = 920;
            MinimumSize = new Size(840, 580);
            StartPosition = FormStartPosition.CenterScreen;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

            loading.Dock = DockStyle.Fill;
            loading.TextAlign = ContentAlignment.MiddleCenter;
            loading.Font = new Font("Microsoft YaHei UI", 12);
            loading.Text = "正在启动论文译读…";
            view.Dock = DockStyle.Fill;
            view.Visible = false;
            Controls.Add(view);
            Controls.Add(loading);
            Shown += StartAsync;
            FormClosed += CloseBackend;
        }

        private async void StartAsync(object sender, EventArgs args)
        {
            try
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string appData = Environment.GetEnvironmentVariable("PAPER_STUDIO_APPDATA");
                if (String.IsNullOrWhiteSpace(appData))
                    appData = Path.Combine(local, "PaperTranslationStudio");
                string data = Environment.GetEnvironmentVariable("PAPER_STUDIO_DATA_DIR");
                if (String.IsNullOrWhiteSpace(data))
                    data = Path.Combine(appData, "data");
                string layoutCache = Environment.GetEnvironmentVariable("PAPER_STUDIO_LAYOUT_CACHE");
                if (String.IsNullOrWhiteSpace(layoutCache))
                    layoutCache = Path.Combine(appData, "layout-assets");
                Directory.CreateDirectory(data);
                Directory.CreateDirectory(layoutCache);

                var startup = Task.Run(() => StartBackend(data, layoutCache));
                if (await Task.WhenAny(startup, Task.Delay(TimeSpan.FromSeconds(45))) != startup)
                    throw new TimeoutException("本地服务启动超时。");
                string address = await startup;
                origin = new Uri(address);
                if (IsDisposed)
                    return;

                var environment = await CoreWebView2Environment.CreateAsync(
                    userDataFolder: Path.Combine(appData, "WebView2"));
                await view.EnsureCoreWebView2Async(environment);
                view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                view.CoreWebView2.NavigationStarting += OnNavigationStarting;
                view.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
                view.CoreWebView2.DownloadStarting += OnDownloadStarting;
                view.Source = origin;
                loading.Visible = false;
                view.Visible = true;
                view.BringToFront();
            }
            catch (Exception error)
            {
                if (!IsDisposed)
                {
                    MessageBox.Show(this, "无法启动论文译读。\n\n" + error.Message,
                        "论文译读", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                }
            }
        }

        private string StartBackend(string data, string layoutCache)
        {
            string appRoot = AppDomain.CurrentDomain.BaseDirectory;
            string app = Path.Combine(appRoot, "paper-translation-studio");
            string python = Path.Combine(appRoot, "pdf2zh", "build", "runtime", "python.exe");
            string server = Path.Combine(app, "server.py");
            if (!File.Exists(python) || !File.Exists(server))
                throw new FileNotFoundException("程序文件不完整，请重新安装。");

            int port;
            string requestedPort = Environment.GetEnvironmentVariable("PAPER_STUDIO_PORT");
            if (!Int32.TryParse(requestedPort, out port) || port < 0 || port > 65535)
                port = 8765;
            var start = new ProcessStartInfo
            {
                FileName = python,
                Arguments = "-X utf8 -B " + Quote(server) + " --desktop-host --port " + port
                    + " --data-dir " + Quote(Path.GetFullPath(data)),
                WorkingDirectory = app,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            start.EnvironmentVariables["PYTHONUTF8"] = "1";
            start.EnvironmentVariables["PDF2ZH_HOME"] = appRoot;
            start.EnvironmentVariables["PAPER_STUDIO_LAYOUT_CACHE"] = Path.GetFullPath(layoutCache);
            backend = Process.Start(start);
            processJob = Native.AttachToJob(backend);
            backend.ErrorDataReceived += (sender, args) => { };
            backend.BeginErrorReadLine();

            string line = backend.StandardOutput.ReadLine();
            const string prefix = "PAPER_STUDIO_URL=";
            Uri address;
            if (line == null || !line.StartsWith(prefix, StringComparison.Ordinal)
                || !Uri.TryCreate(line.Substring(prefix.Length), UriKind.Absolute, out address)
                || address.Scheme != Uri.UriSchemeHttp || address.Host != "127.0.0.1")
                throw new InvalidOperationException("本地服务未能启动，请检查程序文件和数据目录。");
            return address.AbsoluteUri;
        }

        private static string Quote(string path)
        {
            return "\"" + path.TrimEnd('\\') + "\"";
        }

        private bool IsLocal(string address)
        {
            Uri uri;
            return origin != null && Uri.TryCreate(address, UriKind.Absolute, out uri)
                && uri.Scheme == origin.Scheme && uri.Host == origin.Host && uri.Port == origin.Port;
        }

        private static void OpenExternal(string address)
        {
            Uri uri;
            if (Uri.TryCreate(address, UriKind.Absolute, out uri)
                && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
                catch (Win32Exception) { }
            }
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            if (!IsLocal(args.Uri))
            {
                args.Cancel = true;
                OpenExternal(args.Uri);
            }
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        }

        private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs args)
        {
            args.Handled = true;
            using (var dialog = new SaveFileDialog())
            {
                dialog.Title = "保存导出文件";
                dialog.FileName = Path.GetFileName(args.ResultFilePath);
                dialog.Filter = "所有文件 (*.*)|*.*";
                dialog.OverwritePrompt = true;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    args.ResultFilePath = dialog.FileName;
                else
                    args.Cancel = true;
            }
        }

        private void CloseBackend(object sender, FormClosedEventArgs args)
        {
            if (backend != null)
            {
                try
                {
                    backend.StandardInput.Close();
                    if (!backend.HasExited && !backend.WaitForExit(2000))
                        backend.Kill();
                }
                catch (InvalidOperationException) { }
                catch (IOException) { }
                catch (Win32Exception) { }
                backend.Dispose();
                backend = null;
            }
            if (processJob != IntPtr.Zero)
            {
                Native.CloseHandle(processJob);
                processJob = IntPtr.Zero;
            }
        }
    }

    internal static class Native
    {
        private const uint KillOnJobClose = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr FindWindow(string className, string windowName);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);

        public static IntPtr AttachToJob(Process process)
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new Win32Exception();
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, 9, buffer, (uint)size)
                    || !AssignProcessToJobObject(job, process.Handle))
                    throw new Win32Exception();
                return job;
            }
            catch
            {
                CloseHandle(job);
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
