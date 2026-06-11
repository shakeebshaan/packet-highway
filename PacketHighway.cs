// PacketHighway — real-time network packet visualizer backend.
// Captures packets via pktmon (built into Windows 10/11), classifies them by
// protocol, attributes them to the owning process (with app icon extraction),
// and streams events to the Three.js frontend over Server-Sent Events.
//
// Build:  csc /optimize /out:PacketHighway.exe /r:System.Drawing.dll PacketHighway.cs
// Run:    PacketHighway.exe [--port 8339] [--demo] [--web <dir>]
// Live capture requires Administrator (pktmon). Demo mode does not.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace PacketHighway
{
    // ------------------------------------------------------------------ model

    class Pkt
    {
        public string Proto;   // https quic http dns ssh icmp arp tcp udp other
        public string Dir;     // "in" | "out"
        public int Bytes;
        public string Src, Dst;
        public int SPort, DPort;
        public string App;     // process name or null
        public string Icon;    // icon cache key or null
        public string Cargo;   // media audio data text lookup control (heuristic) or null
        public string Dest;    // destination company name (prefix/rDNS heuristic) or null
        public bool Wire;      // long-lived socket (websocket-ish) -> power line pulse
        public long T;         // unix ms
    }

    static class Json
    {
        public static string Esc(string s)
        {
            if (s == null) return null;
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        public static string Str(string s) { return s == null ? "null" : "\"" + Esc(s) + "\""; }

        public static string Of(Pkt p)
        {
            return "{\"proto\":\"" + p.Proto + "\",\"dir\":\"" + p.Dir + "\",\"bytes\":" + p.Bytes
                 + ",\"src\":" + Str(p.Src) + ",\"dst\":" + Str(p.Dst)
                 + ",\"sport\":" + p.SPort + ",\"dport\":" + p.DPort
                 + ",\"app\":" + Str(p.App) + ",\"icon\":" + Str(p.Icon)
                 + ",\"cargo\":" + Str(p.Cargo) + ",\"dest\":" + Str(p.Dest)
                 + ",\"wire\":" + (p.Wire ? "true" : "false") + ",\"t\":" + p.T + "}";
        }
    }

    // ---------------------------------------------------- port -> process map

    static class PortMap
    {
        [DllImport("iphlpapi.dll", SetLastError = true)]
        static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sort, int af, int cls, uint res);
        [DllImport("iphlpapi.dll", SetLastError = true)]
        static extern uint GetExtendedUdpTable(IntPtr table, ref int size, bool sort, int af, int cls, uint res);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(int access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder exe, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr h);

        const int AF_INET = 2, AF_INET6 = 23;
        const int TCP_TABLE_OWNER_PID_ALL = 5, UDP_TABLE_OWNER_PID = 1;

        static volatile Dictionary<int, int> _tcp = new Dictionary<int, int>();
        static volatile Dictionary<int, int> _udp = new Dictionary<int, int>();

        public class Conn { public string RemoteIp; public int RemotePort; public int LocalPort; public int Pid; public int AgeSec; }
        public static volatile List<Conn> Conns = new List<Conn>();
        static readonly Dictionary<string, DateTime> _connSeen = new Dictionary<string, DateTime>();
        static volatile HashSet<int> _wirePorts = new HashSet<int>(); // local ports of long-lived conns

        public static bool IsLongLived(int localPort) { return _wirePorts.Contains(localPort); }

        public static void Start()
        {
            var t = new Thread(() =>
            {
                while (true)
                {
                    try { Refresh(); } catch { }
                    Thread.Sleep(2000);
                }
            });
            t.IsBackground = true; t.Start();
        }

        public static int PidForTcp(int localPort) { int pid; return _tcp.TryGetValue(localPort, out pid) ? pid : 0; }
        public static int PidForUdp(int localPort) { int pid; return _udp.TryGetValue(localPort, out pid) ? pid : 0; }

        static void Refresh()
        {
            var tcp = new Dictionary<int, int>();
            var udp = new Dictionary<int, int>();
            var conns = new List<Conn>();
            // TCP v4: rows of 6 DWORDs; state@0 localAddr@4 localPort@8 remoteAddr@12 remotePort@16 pid@20
            ReadTable(true, AF_INET, 24, 8, 20, tcp, conns, 12, 16);
            // TCP v6: addr16 scope4 port4 addr16 scope4 port4 state4 pid4 => port@20 pid@52 remote@24 rport@44
            ReadTable(true, AF_INET6, 56, 20, 52, tcp, conns, 24, 44);
            // UDP v4: addr4 port4 pid4 => port@4 pid@8
            ReadTable(false, AF_INET, 12, 4, 8, udp, null, 0, 0);
            // UDP v6: addr16 scope4 port4 pid4 => port@20 pid@24
            ReadTable(false, AF_INET6, 28, 20, 24, udp, null, 0, 0);
            // connection age: long-lived sockets (websockets, push channels) become "wires"
            var nowT = DateTime.UtcNow;
            var alive = new HashSet<string>();
            var wires = new HashSet<int>();
            foreach (var cn in conns)
            {
                string k = cn.RemoteIp + ":" + cn.RemotePort + ":" + cn.LocalPort;
                alive.Add(k);
                DateTime first;
                if (!_connSeen.TryGetValue(k, out first)) { _connSeen[k] = nowT; first = nowT; }
                cn.AgeSec = (int)(nowT - first).TotalSeconds;
                if (cn.AgeSec > 30) wires.Add(cn.LocalPort);
            }
            var dead = new List<string>();
            foreach (var k in _connSeen.Keys) if (!alive.Contains(k)) dead.Add(k);
            foreach (var k in dead) _connSeen.Remove(k);

            _tcp = tcp; _udp = udp; Conns = conns; _wirePorts = wires;
        }

        static int Ntohs(int raw) { return ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF); }

        static void ReadTable(bool isTcp, int af, int rowSize, int portOff, int pidOff,
                              Dictionary<int, int> into, List<Conn> conns, int remoteOff, int remotePortOff)
        {
            int size = 0;
            if (isTcp) GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, TCP_TABLE_OWNER_PID_ALL, 0);
            else GetExtendedUdpTable(IntPtr.Zero, ref size, false, af, UDP_TABLE_OWNER_PID, 0);
            if (size <= 0) return;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                uint r = isTcp
                    ? GetExtendedTcpTable(buf, ref size, false, af, TCP_TABLE_OWNER_PID_ALL, 0)
                    : GetExtendedUdpTable(buf, ref size, false, af, UDP_TABLE_OWNER_PID, 0);
                if (r != 0) return;
                int n = Marshal.ReadInt32(buf);
                IntPtr row = buf + 4;
                for (int i = 0; i < n; i++)
                {
                    int port = Ntohs(Marshal.ReadInt32(row, portOff));
                    int pid = Marshal.ReadInt32(row, pidOff);
                    if (port != 0 && !into.ContainsKey(port)) into[port] = pid;

                    if (conns != null) // collect established remote endpoints (lite-live mode)
                    {
                        int rport = Ntohs(Marshal.ReadInt32(row, remotePortOff));
                        if (rport != 0)
                        {
                            string rip = null;
                            if (af == AF_INET)
                            {
                                var b4 = new byte[4]; Marshal.Copy(row + remoteOff, b4, 0, 4);
                                if (!(b4[0] == 0 || b4[0] == 127)) rip = new System.Net.IPAddress(b4).ToString();
                            }
                            else
                            {
                                var b16 = new byte[16]; Marshal.Copy(row + remoteOff, b16, 0, 16);
                                bool zero = true; for (int k = 0; k < 16; k++) if (b16[k] != 0) { zero = false; break; }
                                if (!zero && b16[0] != 0xfe) rip = new System.Net.IPAddress(b16).ToString();
                            }
                            if (rip != null && rip != "::1")
                                conns.Add(new Conn { RemoteIp = rip, RemotePort = rport, LocalPort = port, Pid = pid });
                        }
                    }
                    row += rowSize;
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        // ---- pid -> (name, icon key) with cache

        class AppInfo { public string Name; public string Icon; public DateTime At; }
        static readonly ConcurrentDictionary<int, AppInfo> _apps = new ConcurrentDictionary<int, AppInfo>();
        public static readonly ConcurrentDictionary<string, byte[]> IconPng = new ConcurrentDictionary<string, byte[]>();

        public static void Resolve(int pid, out string name, out string icon)
        {
            name = null; icon = null;
            if (pid <= 0) return;
            if (pid == 4) { name = "System"; return; }
            AppInfo a;
            if (_apps.TryGetValue(pid, out a) && (DateTime.UtcNow - a.At).TotalSeconds < 60)
            { name = a.Name; icon = a.Icon; return; }

            string path = ExePath(pid);
            if (path == null) { _apps[pid] = new AppInfo { At = DateTime.UtcNow }; return; }
            name = Path.GetFileNameWithoutExtension(path);
            string key = Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9_-]", "_");
            if (!IconPng.ContainsKey(key))
            {
                byte[] png = ExtractIconPng(path);
                if (png != null) IconPng[key] = png; else key = null;
            }
            icon = IconPng.ContainsKey(key ?? "") ? key : null;
            _apps[pid] = new AppInfo { Name = name, Icon = icon, At = DateTime.UtcNow };
        }

        public static string ExePath(int pid)
        {
            IntPtr h = OpenProcess(0x1000 /*QUERY_LIMITED_INFORMATION*/, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024); int len = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref len) ? sb.ToString() : null;
            }
            finally { CloseHandle(h); }
        }

        public static byte[] ExtractIconPng(string exePath)
        {
            try
            {
                using (var ico = System.Drawing.Icon.ExtractAssociatedIcon(exePath))
                using (var bmp = new Bitmap(48, 48, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawIcon(ico, new Rectangle(0, 0, 48, 48));
                    using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
                }
            }
            catch { return null; }
        }
    }

    // ------------------------------------------------------------ SSE hub

    static class Hub
    {
        class Client { public Stream S; public object Lock = new object(); }
        static readonly List<Client> _clients = new List<Client>();

        public static int Count { get { lock (_clients) return _clients.Count; } }

        public static void Add(Stream s)
        {
            var c = new Client { S = s };
            lock (_clients) _clients.Add(c);
        }

        public static void Broadcast(string evt, string json)
        {
            byte[] data = Encoding.UTF8.GetBytes("event: " + evt + "\ndata: " + json + "\n\n");
            List<Client> dead = null;
            Client[] snap;
            lock (_clients) snap = _clients.ToArray();
            foreach (var c in snap)
            {
                try { lock (c.Lock) { c.S.Write(data, 0, data.Length); c.S.Flush(); } }
                catch { (dead = dead ?? new List<Client>()).Add(c); }
            }
            if (dead != null) lock (_clients) foreach (var c in dead) { _clients.Remove(c); try { c.S.Close(); } catch { } }
        }
    }

    // ------------------------------------------------------------ statistics

    static class Stats
    {
        public static long PktsIn, PktsOut, BytesIn, BytesOut, Shown, Total;
        public static string Mode = "starting", Source = "pktmon @ any";

        public static void Count(Pkt p, bool shown)
        {
            if (p.Dir == "in") { Interlocked.Increment(ref PktsIn); Interlocked.Add(ref BytesIn, p.Bytes); }
            else { Interlocked.Increment(ref PktsOut); Interlocked.Add(ref BytesOut, p.Bytes); }
            Interlocked.Increment(ref Total);
            if (shown) Interlocked.Increment(ref Shown);
        }

        // bulk-add packets that are counted but not individually visualized
        public static void Bulk(bool inDir, long pkts, long bytes)
        {
            if (pkts <= 0) return;
            if (inDir) { Interlocked.Add(ref PktsIn, pkts); Interlocked.Add(ref BytesIn, bytes); }
            else { Interlocked.Add(ref PktsOut, pkts); Interlocked.Add(ref BytesOut, bytes); }
            Interlocked.Add(ref Total, pkts);
        }

        public static void Start()
        {
            var t = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(1000);
                    long pi = Interlocked.Exchange(ref PktsIn, 0), po = Interlocked.Exchange(ref PktsOut, 0);
                    long bi = Interlocked.Exchange(ref BytesIn, 0), bo = Interlocked.Exchange(ref BytesOut, 0);
                    long sh = Interlocked.Exchange(ref Shown, 0), tot = Interlocked.Exchange(ref Total, 0);
                    int pct = tot == 0 ? 100 : (int)(sh * 100 / tot);
                    Hub.Broadcast("stats", "{\"ppsIn\":" + pi + ",\"ppsOut\":" + po +
                        ",\"bpsIn\":" + bi + ",\"bpsOut\":" + bo + ",\"pct\":" + pct +
                        ",\"ping\":" + NetInfo.PingMs + ",\"link\":" + NetInfo.LinkBps +
                        ",\"servers\":" + NetInfo.Count +
                        ",\"mode\":" + Json.Str(Mode) + ",\"source\":" + Json.Str(Source) + "}");
                }
            });
            t.IsBackground = true; t.Start();
        }
    }

    // ---------------------------------------------------------- packet queue

    static class Pipe
    {
        static readonly ConcurrentQueue<Pkt> _q = new ConcurrentQueue<Pkt>();
        const int MAX_VISUAL_PER_FLUSH = 12; // sampling cap: ~100 cars/s max to renderer

        public static void Push(Pkt p)
        {
            p.Cargo = CargoOf(p);
            string remote = p.Dir == "out" ? p.Dst : p.Src;
            NetInfo.Touch(remote, p.App, p.Icon);
            p.Dest = Dest.Of(remote, NetInfo.HostOf(remote));
            bool shown = _q.Count < MAX_VISUAL_PER_FLUSH * 4;
            Stats.Count(p, shown);
            if (shown) _q.Enqueue(p);
        }

        // payloads are encrypted — classify what's "in transit" by size + app heuristics
        static string CargoOf(Pkt p)
        {
            if (p.Proto == "dns") return "lookup";
            if (p.Proto == "arp" || p.Proto == "icmp") return null;
            string a = p.App == null ? "" : p.App.ToLowerInvariant();
            if (p.Bytes >= 1100)
                return (a.Contains("spotify") || a.Contains("music") || a.Contains("audio")) ? "audio" : "media";
            if (p.Bytes >= 400) return "data";
            if (p.Bytes >= 120) return "text";
            return "control";
        }

        public static void Start()
        {
            var t = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(120);
                    if (_q.IsEmpty || Hub.Count == 0) { Pkt drop; while (Hub.Count == 0 && _q.TryDequeue(out drop)) { } continue; }
                    var sb = new StringBuilder("[");
                    Pkt p; int n = 0;
                    while (n < MAX_VISUAL_PER_FLUSH && _q.TryDequeue(out p))
                    { if (n++ > 0) sb.Append(','); sb.Append(Json.Of(p)); }
                    // overflow beyond cap is dropped silently (already counted in stats)
                    while (_q.Count > 200 && _q.TryDequeue(out p)) { }
                    sb.Append(']');
                    if (n > 0) Hub.Broadcast("pkts", sb.ToString());
                }
            });
            t.IsBackground = true; t.Start();
        }
    }

    // ------------------------------------- destination naming (ambient flavor)

    static class Dest
    {
        static readonly string[][] Prefix = {
            new[]{"8.8.","Google"}, new[]{"142.250.","Google"}, new[]{"172.217.","Google"},
            new[]{"216.58.","Google"}, new[]{"74.125.","Google"}, new[]{"64.233.","Google"},
            new[]{"1.1.1.","Cloudflare"}, new[]{"1.0.0.","Cloudflare"}, new[]{"162.159.","Cloudflare"},
            new[]{"104.16.","Cloudflare"}, new[]{"104.17.","Cloudflare"}, new[]{"104.18.","Cloudflare"},
            new[]{"104.19.","Cloudflare"}, new[]{"104.20.","Cloudflare"},
            new[]{"172.64.","Cloudflare"}, new[]{"172.65.","Cloudflare"}, new[]{"172.66.","Cloudflare"}, new[]{"172.67.","Cloudflare"},
            new[]{"13.","Microsoft"}, new[]{"20.","Microsoft"}, new[]{"40.","Microsoft"},
            new[]{"151.101.","Fastly"}, new[]{"199.232.","Fastly"},
            new[]{"185.199.10","GitHub"}, new[]{"140.82.","GitHub"},
            new[]{"3.","AWS"}, new[]{"18.","AWS"}, new[]{"54.","AWS"},
            new[]{"17.","Apple"},
            new[]{"31.13.","Meta"}, new[]{"157.240.","Meta"},
            new[]{"23.","Akamai"}
        };

        public static string Of(string ip, string host)
        {
            if (!string.IsNullOrEmpty(host))
            {
                string h = host.ToLowerInvariant();
                if (h.EndsWith("1e100.net") || h.Contains("google")) return "Google";
                if (h.Contains("amazonaws") || h.Contains("cloudfront")) return "AWS";
                if (h.Contains("cloudflare")) return "Cloudflare";
                if (h.Contains("akamai")) return "Akamai";
                if (h.Contains("azure") || h.Contains("microsoft") || h.Contains("msedge")) return "Microsoft";
                if (h.Contains("fastly")) return "Fastly";
                if (h.Contains("github")) return "GitHub";
                if (h.Contains("fbcdn") || h.Contains("facebook")) return "Meta";
                if (h.Contains("apple") || h.Contains("icloud")) return "Apple";
                if (h.Contains("discord")) return "Discord";
                if (h.Contains("spotify")) return "Spotify";
                if (h.Contains("steam")) return "Steam";
                if (h.Contains("netflix") || h.Contains("nflx")) return "Netflix";
            }
            if (ip == null) return null;
            foreach (var p in Prefix) if (ip.StartsWith(p[0])) return p[1];
            return null;
        }
    }

    // ------------------------------------------- ping / link / server tracking

    static class NetInfo
    {
        public static volatile int PingMs = -1;
        public static long LinkBps;        // adapter link speed, bits/s
        static long _lastFault = -1;       // discarded/errored packet counter watermark
        static bool _pingOk = true;

        class Srv { public long Pkts; public DateTime Last; public string App; public string Icon; public string Host; public bool Resolving; }
        static readonly ConcurrentDictionary<string, Srv> _servers = new ConcurrentDictionary<string, Srv>();

        public static int Count { get { return _servers.Count; } }

        public static string HostOf(string ip)
        {
            Srv s;
            return ip != null && _servers.TryGetValue(ip, out s) ? s.Host : null;
        }

        public static void Touch(string ip, string app, string icon)
        {
            if (string.IsNullOrEmpty(ip)) return;
            if (ip.StartsWith("192.168.") || ip.StartsWith("10.") || ip.StartsWith("172.16.") ||
                ip.StartsWith("127.") || ip.StartsWith("169.254") || ip.StartsWith("fe80") ||
                ip.StartsWith("ff0") || ip == "::1" || ip.EndsWith(".255")) return;
            var s = _servers.GetOrAdd(ip, _ => new Srv());
            s.Pkts++; s.Last = DateTime.UtcNow;
            if (app != null) { s.App = app; s.Icon = icon; }
        }

        public static void Start()
        {
            var t1 = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        using (var p = new System.Net.NetworkInformation.Ping())
                        {
                            var r = p.Send("1.1.1.1", 3000);
                            PingMs = r.Status == IPStatus.Success ? (int)r.RoundtripTime : -1;
                        }
                    }
                    catch { PingMs = -1; }
                    // ping went from healthy to lost -> accident on the highway
                    bool ok = PingMs >= 0;
                    if (_pingOk && !ok) Hub.Broadcast("acc", "{\"kind\":\"loss\",\"n\":1}");
                    _pingOk = ok;
                    try
                    {
                        long best = 0, fault = 0;
                        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                            if (ni.OperationalStatus == OperationalStatus.Up &&
                                ni.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
                                ni.GetIPProperties().GatewayAddresses.Count > 0)
                            {
                                if (ni.Speed > best) best = ni.Speed;
                                var st = ni.GetIPv4Statistics();
                                fault += st.IncomingPacketsDiscarded + st.IncomingPacketsWithErrors
                                       + st.OutgoingPacketsDiscarded;
                            }
                        LinkBps = best;
                        // OS-level discarded/errored packets since last poll -> accident
                        if (_lastFault >= 0 && fault > _lastFault)
                            Hub.Broadcast("acc", "{\"kind\":\"drop\",\"n\":" + (fault - _lastFault) + "}");
                        _lastFault = fault;
                    }
                    catch { }
                    Thread.Sleep(5000);
                }
            });
            t1.IsBackground = true; t1.Start();

            var t2 = new Thread(() =>
            {
                while (true) { Thread.Sleep(4000); try { Broadcast(); } catch { } }
            });
            t2.IsBackground = true; t2.Start();

            // auto-pause the wallpaper while a fullscreen app / game is up
            var t3 = new Thread(() =>
            {
                int lastPause = -1;
                while (true)
                {
                    Thread.Sleep(2000);
                    try
                    {
                        int st;
                        bool pause = SHQueryUserNotificationState(out st) == 0 &&
                                     (st == 2 /*busy*/ || st == 3 /*d3d fullscreen*/ || st == 4 /*presentation*/);
                        int pv = pause ? 1 : 0;
                        if (pv != lastPause)
                        {
                            lastPause = pv;
                            Hub.Broadcast("control", "{\"pause\":" + (pause ? "true" : "false") + "}");
                        }
                    }
                    catch { }
                }
            });
            t3.IsBackground = true; t3.Start();
        }

        [DllImport("shell32.dll")]
        static extern int SHQueryUserNotificationState(out int state);

        static void Broadcast()
        {
            foreach (var kv in _servers)
                if ((DateTime.UtcNow - kv.Value.Last).TotalSeconds > 60)
                { Srv gone; _servers.TryRemove(kv.Key, out gone); }

            var top = _servers.OrderByDescending(kv => kv.Value.Pkts).Take(6).ToList();
            foreach (var kv in top)
            {
                var s = kv.Value; string ip = kv.Key;
                if (s.Host == null && !s.Resolving)
                {
                    s.Resolving = true;
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        try { s.Host = System.Net.Dns.GetHostEntry(ip).HostName.TrimEnd('.'); }
                        catch { s.Host = ""; }
                    });
                }
            }
            var sb = new StringBuilder("{\"count\":" + _servers.Count + ",\"top\":[");
            for (int i = 0; i < top.Count; i++)
            {
                var s = top[i].Value;
                if (i > 0) sb.Append(',');
                sb.Append("{\"ip\":" + Json.Str(top[i].Key) + ",\"host\":" + Json.Str(string.IsNullOrEmpty(s.Host) ? null : s.Host)
                        + ",\"name\":" + Json.Str(Dest.Of(top[i].Key, s.Host))
                        + ",\"app\":" + Json.Str(s.App) + ",\"icon\":" + Json.Str(s.Icon) + ",\"pkts\":" + s.Pkts + "}");
            }
            sb.Append("]}");
            Hub.Broadcast("servers", sb.ToString());
        }
    }

    // ------------------------------------------------------------- capture

    static class Capture
    {
        static readonly HashSet<string> _localIps = new HashSet<string>();
        static Process _proc;
        static readonly Queue<long> _seenGroups = new Queue<long>();
        static readonly HashSet<long> _seenSet = new HashSet<long>();
        static DateTime _lastDup = DateTime.MinValue;

        public static void RefreshLocalIps()
        {
            try
            {
                _localIps.Clear();
                _localIps.Add("127.0.0.1"); _localIps.Add("::1");
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                        _localIps.Add(ua.Address.ToString());
            }
            catch { }
        }

        public static bool IsLocal(string ip) { return ip != null && _localIps.Contains(ip); }

        public static void Start()
        {
            RefreshLocalIps();
            var t = new Thread(Run); t.IsBackground = true; t.Start();
        }

        static void Run()
        {
            try { RunPktmon("stop"); } catch { } // clean stale session
            try
            {
                _proc = new Process();
                _proc.StartInfo.FileName = "pktmon";
                _proc.StartInfo.Arguments = "start --capture --comp nics --pkt-size 0 --log-mode real-time";
                _proc.StartInfo.UseShellExecute = false;
                _proc.StartInfo.RedirectStandardOutput = true;
                _proc.StartInfo.RedirectStandardError = true;
                _proc.StartInfo.CreateNoWindow = true;
                _proc.Start();
                Stats.Mode = "live";
                Console.WriteLine("[capture] pktmon real-time started (pid " + _proc.Id + ")");

                var errSb = new StringBuilder();
                _proc.ErrorDataReceived += (s, e) => { if (e.Data != null) errSb.AppendLine(e.Data); };
                _proc.BeginErrorReadLine();

                // sample the first raw lines to disk so format mismatches are diagnosable
                string samplePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "capture_sample.log");
                try { File.Delete(samplePath); } catch { }
                int sampled = 0;

                string line;
                while ((line = _proc.StandardOutput.ReadLine()) != null)
                {
                    if (sampled < 60) { sampled++; try { File.AppendAllText(samplePath, line + "\r\n"); } catch { } }
                    try { Parse(line); } catch { } // one bad line must not kill capture
                }

                _proc.WaitForExit();
                Console.WriteLine("[capture] pktmon exited code " + _proc.ExitCode);
                if (errSb.Length > 0) Console.WriteLine("[capture] stderr: " + errSb);
                Stats.Mode = "error";
                Stats.Source = "pktmon exited — run as Administrator?";
            }
            catch (Exception ex)
            {
                Console.WriteLine("[capture] failed: " + ex.Message);
                Stats.Mode = "error";
                Stats.Source = "pktmon unavailable";
            }
        }

        public static void Stop()
        {
            try { if (_proc != null && !_proc.HasExited) _proc.Kill(); } catch { }
            try { RunPktmon("stop"); } catch { }
        }

        static void RunPktmon(string args)
        {
            var p = Process.Start(new ProcessStartInfo("pktmon", args)
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
            p.WaitForExit(8000);
        }

        // ---- line parser (tolerant: handles one-line and metadata+payload formats)

        static string _pendDir; static int _pendSize;
        static readonly Regex ReMeta = new Regex(@"Direction\s+(Rx|Tx).*?OriginalSize\s+(\d+)", RegexOptions.Compiled);
        static readonly Regex ReMetaAlt = new Regex(@"\b(Rx|Tx)\b.*?OriginalSize\s+(\d+)", RegexOptions.Compiled);
        static readonly Regex ReGroup = new Regex(@"PktGroupId\s+(\d+)", RegexOptions.Compiled);
        static readonly Regex ReV4 = new Regex(@"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[.:](\d{1,5})\s*>\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[.:](\d{1,5})", RegexOptions.Compiled);
        static readonly Regex ReV4NoPort = new Regex(@"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*>\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})", RegexOptions.Compiled);
        static readonly Regex ReV6 = new Regex(@"([0-9a-fA-F:]+(?:%\d+)?)\.(\d{1,5})\s*>\s*([0-9a-fA-F:]+(?:%\d+)?)\.(\d{1,5})", RegexOptions.Compiled);
        static readonly Regex ReLen = new Regex(@"length[:\s]+(\d+)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        public static void Parse(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;

            // dedup multiple stack appearances of the same packet
            var g = ReGroup.Match(line);
            if (g.Success)
            {
                long id = long.Parse(g.Groups[1].Value);
                if (_seenSet.Contains(id))
                {
                    // same PktGroupId again = duplicate packet on the wire
                    if ((DateTime.UtcNow - _lastDup).TotalSeconds > 15)
                    {
                        _lastDup = DateTime.UtcNow;
                        Hub.Broadcast("acc", "{\"kind\":\"dup\",\"n\":1}");
                    }
                    return;
                }
                _seenSet.Add(id); _seenGroups.Enqueue(id);
                if (_seenGroups.Count > 2048) _seenSet.Remove(_seenGroups.Dequeue());
            }

            var meta = ReMeta.Match(line);
            if (!meta.Success && line.Contains("OriginalSize")) meta = ReMetaAlt.Match(line);
            if (meta.Success)
            {
                _pendDir = meta.Groups[1].Value == "Rx" ? "in" : "out";
                _pendSize = int.Parse(meta.Groups[2].Value);
                // metadata and payload may share one line — fall through
            }

            string proto = null, src = null, dst = null;
            int sport = 0, dport = 0;

            bool isArp = line.IndexOf("ARP", StringComparison.OrdinalIgnoreCase) >= 0;
            bool isIcmp = !isArp && Regex.IsMatch(line, @"\bICMP", RegexOptions.IgnoreCase);
            bool isTcp = !isArp && !isIcmp && Regex.IsMatch(line, @"\bTCP\b|\bFlags\s*\[", RegexOptions.IgnoreCase);
            bool isUdp = !isArp && !isIcmp && !isTcp && Regex.IsMatch(line, @"\bUDP\b", RegexOptions.IgnoreCase);

            var m = ReV4.Match(line);
            if (m.Success)
            {
                src = m.Groups[1].Value; sport = SafePort(m.Groups[2].Value);
                dst = m.Groups[3].Value; dport = SafePort(m.Groups[4].Value);
            }
            else
            {
                var m6 = ReV6.Match(line);
                if (m6.Success && m6.Groups[1].Value.Contains(":"))
                {
                    src = m6.Groups[1].Value; sport = SafePort(m6.Groups[2].Value);
                    dst = m6.Groups[3].Value; dport = SafePort(m6.Groups[4].Value);
                }
                else
                {
                    var m4 = ReV4NoPort.Match(line);
                    if (m4.Success) { src = m4.Groups[1].Value; dst = m4.Groups[2].Value; }
                }
            }

            if (isArp) proto = "arp";
            else if (isIcmp) proto = "icmp";
            else if (isTcp || isUdp)
            {
                bool tcp = isTcp;
                if (sport == 443 || dport == 443) proto = tcp ? "https" : "quic";
                else if (tcp && (sport == 80 || dport == 80)) proto = "http";
                else if (sport == 53 || dport == 53) proto = "dns";
                else if (tcp && (sport == 22 || dport == 22)) proto = "ssh";
                else proto = tcp ? "tcp" : "udp";
            }
            else if (src != null) proto = "other";
            else
            {
                // pure metadata line (payload on next line) or noise
                if (meta.Success) return;
                return;
            }

            int bytes = _pendSize > 0 ? _pendSize : 0;
            if (bytes == 0) { var lm = ReLen.Match(line); if (lm.Success) bytes = int.Parse(lm.Groups[1].Value) + 54; }
            if (bytes == 0) bytes = 60;

            string dir = _pendDir;
            if (dir == null)
            {
                if (IsLocal(src)) dir = "out";
                else if (IsLocal(dst)) dir = "in";
                else dir = "in";
            }
            _pendDir = null; _pendSize = 0;

            var pkt = new Pkt
            {
                Proto = proto, Dir = dir, Bytes = bytes,
                Src = src, Dst = dst, SPort = sport, DPort = dport,
                T = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };

            // app attribution: local-side port -> pid -> exe name + icon
            int localPort = dir == "out" ? sport : dport;
            if (localPort > 0 && proto != "arp" && proto != "icmp")
            {
                bool tcpish = proto == "https" || proto == "http" || proto == "ssh" || proto == "tcp";
                int pid = tcpish ? PortMap.PidForTcp(localPort) : PortMap.PidForUdp(localPort);
                if (pid == 0) pid = tcpish ? PortMap.PidForUdp(localPort) : PortMap.PidForTcp(localPort);
                string name, icon; PortMap.Resolve(pid, out name, out icon);
                pkt.App = name; pkt.Icon = icon;
                if (tcpish) pkt.Wire = PortMap.IsLongLived(localPort);
            }

            Pipe.Push(pkt);
        }

        static int SafePort(string s) { int p; return int.TryParse(s, out p) && p <= 65535 ? p : 0; }
    }

    // ------------------------------------------------------- local weather
    // free + keyless: ip-api.com for coarse location, open-meteo for weather.
    // refreshed every 15 min; clients get the last value on connect.

    static class Weather
    {
        public static volatile string LastEnv = null;

        static double Num(string s, string key, double fallback)
        {
            int i = s.IndexOf(key, StringComparison.OrdinalIgnoreCase);
            if (i < 0) return fallback;
            i += key.Length;
            int e = i;
            while (e < s.Length && (char.IsDigit(s[e]) || s[e] == '.' || s[e] == '-')) e++;
            double v;
            return double.TryParse(s.Substring(i, e - i), System.Globalization.NumberStyles.Float,
                CultureInfo.InvariantCulture, out v) ? v : fallback;
        }

        public static void Start()
        {
            var t = new Thread(() =>
            {
                System.Net.ServicePointManager.SecurityProtocol = System.Net.SecurityProtocolType.Tls12;
                while (true)
                {
                    try
                    {
                        using (var wc = new System.Net.WebClient())
                        {
                            string geo = wc.DownloadString("http://ip-api.com/json/?fields=lat,lon");
                            double lat = Num(geo, "\"lat\":", 0), lon = Num(geo, "\"lon\":", 0);
                            string wx = wc.DownloadString(
                                "https://api.open-meteo.com/v1/forecast?latitude=" + lat.ToString(CultureInfo.InvariantCulture) +
                                "&longitude=" + lon.ToString(CultureInfo.InvariantCulture) +
                                "&current=precipitation,weather_code,is_day");
                            double prec = Num(wx, "\"precipitation\":", 0);
                            double code = Num(wx, "\"weather_code\":", 0);
                            double isday = Num(wx, "\"is_day\":", 0);
                            LastEnv = "{\"precip\":" + prec.ToString(CultureInfo.InvariantCulture) +
                                      ",\"code\":" + (int)code + ",\"isDay\":" + (int)isday + "}";
                            Hub.Broadcast("env", LastEnv);
                            Console.WriteLine("[weather] " + LastEnv);
                        }
                    }
                    catch (Exception ex) { Console.WriteLine("[weather] failed: " + ex.Message); }
                    Thread.Sleep(15 * 60 * 1000);
                }
            });
            t.IsBackground = true; t.Start();
        }
    }

    // ------------------------------------------------------- system stats
    // cpu/ram/disk/gpu telemetry for the utilities district + the process
    // skyline (no admin required for any of these)

    static class Sys
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MEMSTAT
        {
            public uint Len; public uint Load;
            public ulong TotalPhys, AvailPhys, TotalPage, AvailPage, TotalVirt, AvailVirt, AvailExt;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GlobalMemoryStatusEx(ref MEMSTAT m);

        public static void Start()
        {
            var t = new Thread(Run); t.IsBackground = true; t.Start();
            var t2 = new Thread(Procs); t2.IsBackground = true; t2.Start();
        }

        static void Run()
        {
            PerformanceCounter cpu = null, dr = null, dw = null;
            try { cpu = new PerformanceCounter("Processor", "% Processor Time", "_Total"); cpu.NextValue(); } catch { }
            try { dr = new PerformanceCounter("PhysicalDisk", "Disk Read Bytes/sec", "_Total"); dr.NextValue(); } catch { }
            try { dw = new PerformanceCounter("PhysicalDisk", "Disk Write Bytes/sec", "_Total"); dw.NextValue(); } catch { }
            var gpu = new List<PerformanceCounter>();
            DateTime gpuRefresh = DateTime.MinValue;

            while (true)
            {
                Thread.Sleep(2000);
                try
                {
                    double c = -1, rd = 0, wr = 0, g = -1;
                    try { if (cpu != null) c = cpu.NextValue(); } catch { }
                    try { if (dr != null) rd = dr.NextValue(); } catch { }
                    try { if (dw != null) wr = dw.NextValue(); } catch { }

                    // GPU 3D engine utilization: per-process instances churn, so the
                    // counter set is rebuilt every 30 s and sampled continuously
                    try
                    {
                        if ((DateTime.UtcNow - gpuRefresh).TotalSeconds > 30)
                        {
                            gpuRefresh = DateTime.UtcNow;
                            foreach (var pc in gpu) try { pc.Dispose(); } catch { }
                            gpu.Clear();
                            var cat = new PerformanceCounterCategory("GPU Engine");
                            foreach (var inst in cat.GetInstanceNames())
                                if (inst.EndsWith("engtype_3D"))
                                    gpu.Add(new PerformanceCounter("GPU Engine", "Utilization Percentage", inst));
                            foreach (var pc in gpu) try { pc.NextValue(); } catch { }
                        }
                        else if (gpu.Count > 0)
                        {
                            double sum = 0;
                            foreach (var pc in gpu) try { sum += pc.NextValue(); } catch { }
                            g = Math.Min(100, sum);
                        }
                    }
                    catch { g = -1; }

                    var ms = new MEMSTAT(); ms.Len = (uint)Marshal.SizeOf(typeof(MEMSTAT));
                    double ramUsed = 0, ramTotal = 0, ramPct = 0;
                    if (GlobalMemoryStatusEx(ref ms))
                    {
                        ramTotal = ms.TotalPhys / 1073741824.0;
                        ramUsed = (ms.TotalPhys - ms.AvailPhys) / 1073741824.0;
                        ramPct = ms.Load;
                    }

                    double duPct = 0;
                    try
                    {
                        var di = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory));
                        duPct = 100.0 * (di.TotalSize - di.TotalFreeSpace) / di.TotalSize;
                    }
                    catch { }

                    var ci = CultureInfo.InvariantCulture;
                    Hub.Broadcast("sys", "{\"cpu\":" + ((int)c) + ",\"gpu\":" + ((int)g) +
                        ",\"ramPct\":" + ((int)ramPct) +
                        ",\"ramUsed\":" + ramUsed.ToString("0.0", ci) + ",\"ramTotal\":" + ramTotal.ToString("0.0", ci) +
                        ",\"disk\":" + ((int)duPct) + ",\"dr\":" + ((long)rd) + ",\"dw\":" + ((long)wr) + "}");
                }
                catch { }
            }
        }

        // top processes by working set -> the skyline; per-process CPU from
        // TotalProcessorTime deltas between polls
        class PSnap { public TimeSpan Cpu; public DateTime At; }
        static readonly Dictionary<int, PSnap> _prev = new Dictionary<int, PSnap>();

        static void Procs()
        {
            while (true)
            {
                Thread.Sleep(4000);
                try
                {
                    var agg = new Dictionary<string, double[]>(); // name -> [ramMB, cpuPct]
                    var seen = new HashSet<int>();
                    foreach (var p in Process.GetProcesses())
                    {
                        try
                        {
                            long ws = p.WorkingSet64;
                            if (ws < 40L * 1048576) continue; // skyline shows the heavyweights
                            string n = p.ProcessName;
                            if (n == "Idle" || n == "System" || n == "Memory Compression") continue;
                            double cpuPct = 0;
                            try
                            {
                                var nowT = DateTime.UtcNow;
                                var tt = p.TotalProcessorTime;
                                PSnap s;
                                seen.Add(p.Id);
                                if (_prev.TryGetValue(p.Id, out s))
                                {
                                    double el = (nowT - s.At).TotalSeconds;
                                    if (el > 0.5)
                                        cpuPct = (tt - s.Cpu).TotalSeconds / el * 100.0 / Environment.ProcessorCount;
                                }
                                _prev[p.Id] = new PSnap { Cpu = tt, At = nowT };
                            }
                            catch { }
                            double[] v;
                            if (!agg.TryGetValue(n, out v)) agg[n] = v = new double[2];
                            v[0] += ws / 1048576.0;
                            v[1] += cpuPct;
                        }
                        catch { }
                        finally { try { p.Dispose(); } catch { } }
                    }
                    var deadKeys = new List<int>();
                    foreach (var k in _prev.Keys) if (!seen.Contains(k)) deadKeys.Add(k);
                    foreach (var k in deadKeys) _prev.Remove(k);

                    var top = agg.OrderByDescending(kv => kv.Value[0]).Take(30).ToList();
                    var sb = new StringBuilder("[");
                    var ci = CultureInfo.InvariantCulture;
                    for (int i = 0; i < top.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        sb.Append("{\"n\":" + Json.Str(top[i].Key) +
                                  ",\"ram\":" + ((int)top[i].Value[0]) +
                                  ",\"cpu\":" + top[i].Value[1].ToString("0.0", ci) + "}");
                    }
                    sb.Append(']');
                    Hub.Broadcast("procs", sb.ToString());
                }
                catch { }
            }
        }
    }

    // ------------------------------------------------------- lite-live mode
    // No-admin "real data": real adapter packet/byte counters set the rates,
    // the real TCP connection table supplies endpoints + owning apps. Only
    // individual packet boundaries are interpolated (pktmon needs admin).

    static class LiteLive
    {
        public static void Start()
        {
            Stats.Mode = "live"; Stats.Source = "net counters · no-admin";
            var t = new Thread(Run); t.IsBackground = true; t.Start();
        }

        static void Run()
        {
            var rnd = new Random();
            long pIn = -1, pOut = 0, bIn = 0, bOut = 0;
            const int TICK_MS = 500, MAX_VISUAL_PER_TICK = 14;

            while (true)
            {
                Thread.Sleep(TICK_MS);
                long cIn = 0, cOut = 0, cbIn = 0, cbOut = 0;
                try
                {
                    foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                    {
                        if (ni.OperationalStatus != OperationalStatus.Up ||
                            ni.NetworkInterfaceType == NetworkInterfaceType.Loopback ||
                            ni.GetIPProperties().GatewayAddresses.Count == 0) continue;
                        var st = ni.GetIPv4Statistics();
                        cIn += st.UnicastPacketsReceived; cOut += st.UnicastPacketsSent;
                        cbIn += st.BytesReceived; cbOut += st.BytesSent;
                    }
                }
                catch { continue; }

                if (pIn < 0) { pIn = cIn; pOut = cOut; bIn = cbIn; bOut = cbOut; continue; }
                long dIn = Math.Max(0, cIn - pIn), dOut = Math.Max(0, cOut - pOut);
                long dbIn = Math.Max(0, cbIn - bIn), dbOut = Math.Max(0, cbOut - bOut);
                pIn = cIn; pOut = cOut; bIn = cbIn; bOut = cbOut;
                if (dIn + dOut == 0) continue;

                var conns = PortMap.Conns;
                long visIn = Math.Min(dIn, MAX_VISUAL_PER_TICK / 2), visOut = Math.Min(dOut, MAX_VISUAL_PER_TICK / 2);
                EmitSide(rnd, conns, true, visIn, dIn, dbIn);
                EmitSide(rnd, conns, false, visOut, dOut, dbOut);
            }
        }

        static void EmitSide(Random rnd, List<PortMap.Conn> conns, bool inDir, long vis, long pkts, long bytes)
        {
            if (pkts <= 0) return;
            long meanSize = Math.Max(60, Math.Min(1500, bytes / pkts));
            long visBytes = 0;
            for (long i = 0; i < vis; i++)
            {
                int sz = (int)Math.Max(60, Math.Min(1500, meanSize * (0.4 + rnd.NextDouble() * 1.4)));
                visBytes += sz;
                var p = new Pkt
                {
                    Dir = inDir ? "in" : "out",
                    Bytes = sz,
                    T = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
                if (conns != null && conns.Count > 0)
                {
                    var cn = conns[rnd.Next(conns.Count)];
                    p.Src = inDir ? cn.RemoteIp : "this PC";
                    p.Dst = inDir ? "this PC" : cn.RemoteIp;
                    p.SPort = inDir ? cn.RemotePort : cn.LocalPort;
                    p.DPort = inDir ? cn.LocalPort : cn.RemotePort;
                    int svc = cn.RemotePort; // classify on the well-known side
                    p.Proto = svc == 443 ? "https" : svc == 80 ? "http" : svc == 53 ? "dns" : svc == 22 ? "ssh" : "tcp";
                    p.Wire = cn.AgeSec > 30; // long-lived socket -> power line pulse
                    string name, icon; PortMap.Resolve(cn.Pid, out name, out icon);
                    p.App = name; p.Icon = icon;
                }
                else p.Proto = "other";
                Pipe.Push(p);
            }
            // remainder: counted in the dashboard, not drawn (sampling pct shows this)
            Stats.Bulk(inDir, pkts - vis, Math.Max(0, bytes - visBytes));
        }
    }

    // --------------------------------------------------------------- demo

    static class Demo
    {
        class FakeApp { public string Name; public string Icon; }

        public static void Start()
        {
            Stats.Mode = "demo"; Stats.Source = "synthetic traffic";
            var apps = FindDemoApps();
            var rnd = new Random();
            string[] protos = { "https", "https", "https", "https", "quic", "quic", "http", "dns", "dns", "tcp", "tcp", "udp", "icmp", "arp", "ssh", "other" };
            // well-known IPs so the servers panel reverse-resolves to real names in demo
            string[] ips = { "1.1.1.1", "8.8.8.8", "140.82.121.4", "142.250.74.110", "104.16.132.229",
                             "13.107.42.16", "151.101.1.140", "162.159.128.233", "20.50.201.200", "185.199.108.153" };
            var t = new Thread(() =>
            {
                while (true)
                {
                    int burst = 1 + rnd.Next(3);
                    for (int i = 0; i < burst; i++)
                    {
                        string proto = protos[rnd.Next(protos.Length)];
                        bool outb = rnd.Next(2) == 0;
                        var app = (proto == "arp" || proto == "icmp" || rnd.Next(5) == 0) ? null : apps[rnd.Next(apps.Count)];
                        int bytes = rnd.Next(10) == 0 ? 800 + rnd.Next(8000) : 60 + rnd.Next(600);
                        Pipe.Push(new Pkt
                        {
                            Proto = proto, Dir = outb ? "out" : "in", Bytes = bytes,
                            Src = outb ? "192.168.1.23" : ips[rnd.Next(ips.Length)], Dst = outb ? ips[rnd.Next(ips.Length)] : "192.168.1.23",
                            SPort = 40000 + rnd.Next(20000), DPort = ProtoPort(proto, rnd),
                            App = app == null ? null : app.Name, Icon = app == null ? null : app.Icon,
                            Wire = rnd.Next(7) == 0,
                            T = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        });
                    }
                    // a synthetic wreck now and then so demo mode shows the feature
                    if (rnd.Next(180) == 0)
                    {
                        string[] kinds = { "drop", "dup", "loss" };
                        Hub.Broadcast("acc", "{\"kind\":\"" + kinds[rnd.Next(kinds.Length)] + "\",\"n\":" + (1 + rnd.Next(4)) + "}");
                    }
                    Thread.Sleep(150 + rnd.Next(500));
                }
            });
            t.IsBackground = true; t.Start();
        }

        static int ProtoPort(string proto, Random rnd)
        {
            switch (proto)
            {
                case "https": case "quic": return 443;
                case "http": return 80;
                case "dns": return 53;
                case "ssh": return 22;
                default: return 1024 + rnd.Next(60000);
            }
        }

        static string RndIp(Random r) { return r.Next(11, 222) + "." + r.Next(255) + "." + r.Next(255) + "." + r.Next(1, 254); }

        static List<FakeApp> FindDemoApps()
        {
            var list = new List<FakeApp>();
            string[] prefer = { "msedge", "chrome", "firefox", "Code", "node", "explorer", "discord", "steam", "spotify", "Teams" };
            foreach (var name in prefer)
            {
                try
                {
                    var procs = Process.GetProcessesByName(name);
                    if (procs.Length == 0) continue;
                    string path = PortMap.ExePath(procs[0].Id);
                    if (path == null) continue;
                    string key = Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9_-]", "_");
                    var png = PortMap.ExtractIconPng(path);
                    if (png != null) PortMap.IconPng[key] = png;
                    list.Add(new FakeApp { Name = name, Icon = png != null ? key : null });
                }
                catch { }
            }
            if (list.Count == 0) list.Add(new FakeApp { Name = "svchost", Icon = null });
            return list;
        }
    }

    // ------------------------------------------------------------ web server

    static class Server
    {
        static string _webDir;

        public static void Start(int port, string webDir)
        {
            _webDir = webDir;
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            Console.WriteLine("[http] serving " + webDir + " at http://localhost:" + port + "/");
            var t = new Thread(() =>
            {
                while (true)
                {
                    TcpClient c;
                    try { c = listener.AcceptTcpClient(); } catch { break; }
                    var ct = new Thread(() => Handle(c)); ct.IsBackground = true; ct.Start();
                }
            });
            t.IsBackground = true; t.Start();
        }

        static void Handle(TcpClient client)
        {
            try
            {
                client.NoDelay = true;
                var s = client.GetStream();
                var reader = new StreamReader(s, Encoding.ASCII, false, 4096, true);
                string reqLine = reader.ReadLine();
                if (reqLine == null) { client.Close(); return; }
                int contentLength = 0;
                string hdr;
                while ((hdr = reader.ReadLine()) != null && hdr.Length > 0)
                {
                    if (hdr.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                        int.TryParse(hdr.Substring(15).Trim(), out contentLength);
                }

                var parts = reqLine.Split(' ');
                if (parts.Length < 2) { client.Close(); return; }
                string verb = parts[0];
                string path = parts[1].Split('?')[0];

                if (path == "/events")
                {
                    var head = Encoding.ASCII.GetBytes(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n");
                    s.Write(head, 0, head.Length);
                    var hello = Encoding.UTF8.GetBytes("event: status\ndata: {\"mode\":" + Json.Str(Stats.Mode) + ",\"source\":" + Json.Str(Stats.Source) + "}\n\n");
                    s.Write(hello, 0, hello.Length); s.Flush();
                    if (Weather.LastEnv != null)
                    {
                        var env = Encoding.UTF8.GetBytes("event: env\ndata: " + Weather.LastEnv + "\n\n");
                        s.Write(env, 0, env.Length); s.Flush();
                    }
                    Hub.Add(s);
                    return; // keep socket open; hub owns it now
                }

                if (path == "/layout")
                {
                    string layoutPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "layout.json");
                    if (verb == "POST")
                    {
                        var buf = new char[Math.Min(contentLength, 65536)];
                        int read = 0;
                        while (read < buf.Length)
                        {
                            int n2 = reader.Read(buf, read, buf.Length - read);
                            if (n2 <= 0) break;
                            read += n2;
                        }
                        string body = new string(buf, 0, read);
                        try { File.WriteAllText(layoutPath, body); } catch { }
                        Hub.Broadcast("layout", body); // live-sync panel layout to the wallpaper
                        Respond(s, "200 OK", "application/json", Encoding.UTF8.GetBytes("{\"ok\":true}"));
                    }
                    else
                    {
                        string json = File.Exists(layoutPath) ? File.ReadAllText(layoutPath) : "{}";
                        Respond(s, "200 OK", "application/json", Encoding.UTF8.GetBytes(json));
                    }
                    client.Close(); return;
                }

                if (path.StartsWith("/icon/"))
                {
                    string key = path.Substring(6).Replace(".png", "");
                    byte[] png;
                    if (PortMap.IconPng.TryGetValue(key, out png)) Respond(s, "200 OK", "image/png", png);
                    else Respond(s, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("no icon"));
                    client.Close(); return;
                }

                if (path == "/") path = "/index.html";
                string file = Path.GetFullPath(Path.Combine(_webDir, path.TrimStart('/')));
                if (file.StartsWith(Path.GetFullPath(_webDir)) && File.Exists(file))
                    Respond(s, "200 OK", Mime(file), File.ReadAllBytes(file));
                else
                    Respond(s, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("not found"));
                client.Close();
            }
            catch { try { client.Close(); } catch { } }
        }

        static string Mime(string f)
        {
            switch (Path.GetExtension(f).ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".png": return "image/png";
                case ".ico": return "image/x-icon";
                case ".svg": return "image/svg+xml";
                default: return "application/octet-stream";
            }
        }

        static void Respond(Stream s, string status, string type, byte[] body)
        {
            var head = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: " + type +
                "\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
            s.Write(head, 0, head.Length);
            s.Write(body, 0, body.Length);
            s.Flush();
        }
    }

    // ----------------------------------------------------------------- main

    static class Program
    {
        static int Main(string[] args)
        {
            int port = 8339;
            bool demo = false;
            string webDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--port" && i + 1 < args.Length) port = int.Parse(args[++i]);
                else if (args[i] == "--demo") demo = true;
                else if (args[i] == "--web" && i + 1 < args.Length) webDir = args[++i];
            }

            if (!Directory.Exists(webDir)) { Console.WriteLine("web dir not found: " + webDir); return 1; }

            Console.WriteLine("PacketHighway backend — " + (demo ? "DEMO mode" : "LIVE capture (pktmon)"));
            PortMap.Start();
            Stats.Start();
            Pipe.Start();
            NetInfo.Start();
            Weather.Start();
            Sys.Start();
            Server.Start(port, webDir);

            if (demo) Demo.Start();
            else
            {
                bool admin = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent())
                    .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
                if (!admin)
                {
                    Console.WriteLine("[warn] not elevated — using real net counters + connection table (lite-live)");
                    Capture.RefreshLocalIps();
                    LiteLive.Start();
                }
                else Capture.Start();
            }

            Console.CancelKeyPress += (s, e) => { Capture.Stop(); Environment.Exit(0); };
            AppDomain.CurrentDomain.ProcessExit += (s, e) => Capture.Stop();
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
    }
}
