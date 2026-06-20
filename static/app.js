(() => {
  "use strict";

  const STORAGE_KEY = "firewalla-dashboard-v1";
  const VIEW_TITLES = {
    overview: "Overview",
    devices: "Devices",
    alarms: "Alarms",
    rules: "Rules",
    network: "Network",
    tools: "Tools",
    settings: "Settings",
  };

  const state = {
    view: "overview",
    settings: loadSettings(),
    cache: {
      hosts: [],
      alarms: [],
      policies: [],
      exceptions: [],
      vpnProfiles: [],
      sysInfo: null,
      mode: null,
      networkConfig: null,
      networkStatus: null,
      health: null,
    },
    refreshTimer: null,
    busy: 0,
    networkStatusPending: false,
  };

  function loadSettings() {
    const defaults = {
      apiUrl: window.location.origin,
      token: "",
      refreshSec: 30,
      confirmDestructive: true,
      compact: false,
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  }

  function syncSettingsFromForm() {
    const urlEl = $("#setting-api-url");
    const tokenEl = $("#setting-token");
    if (!urlEl || !tokenEl) return;
    const url = urlEl.value.trim().replace(/\/$/, "");
    const token = tokenEl.value.trim();
    if (url) state.settings.apiUrl = url;
    if (token) state.settings.token = token;
  }

  function hasToken() {
    syncSettingsFromForm();
    return Boolean(state.settings.token);
  }

  function $(sel) {
    return document.querySelector(sel);
  }

  function esc(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    const n = Number(ts);
    const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
    if (Number.isNaN(d.getTime())) return esc(ts);
    return d.toLocaleString();
  }

  function fmtBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
    return `${v} B`;
  }

  function fmtUptime(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s)) return "—";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function hostName(h) {
    return (
      h.bname ||
      h.dhcpName ||
      h.userLocalDomain ||
      h.localDomain ||
      h["p.device.name"] ||
      h.mac ||
      h.ip ||
      "Unknown"
    );
  }

  function setBusy(on) {
    state.busy += on ? 1 : -1;
    $("#loading").classList.toggle("show", state.busy > 0);
  }

  function toast(message, type = "success") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function setConnected(ok, detail = "") {
    const pill = $("#conn-pill");
    pill.textContent = ok ? "Connected" : "Offline";
    pill.className = `status-pill ${ok ? "online" : "offline"}`;
    $("#sidebar-status").textContent = ok
      ? `Connected · ${detail || state.settings.apiUrl}`
      : detail || "Configure token in Settings";
    document.body.classList.toggle("compact", !!state.settings.compact);
  }

  async function api(path, options = {}) {
    const { timeoutMs, ...fetchOptions } = options;
    const base = state.settings.apiUrl.replace(/\/$/, "");
    const headers = { Accept: "application/json", ...(fetchOptions.headers || {}) };
    if (state.settings.token) {
      headers.Authorization = `Bearer ${state.settings.token}`;
    }
    if (fetchOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const controller = new AbortController();
    let timer;
    if (timeoutMs) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const res = await fetch(`${base}${path}`, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
        body: fetchOptions.body !== undefined ? JSON.stringify(fetchOptions.body) : undefined,
      });
      let data = null;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      if (!res.ok) {
        const msg = data?.error || data?.detail || data?.message || res.statusText;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function mobile(name) {
    const data = await api(`/api/v1/mobile/${encodeURIComponent(name)}`);
    return data.result?.data ?? data.result ?? data;
  }

  async function netbotCmd(item, value = {}) {
    const data = await api("/api/v1/netbot", {
      method: "POST",
      body: { mtype: "cmd", data: { item, value } },
    });
    return data.result;
  }

  function alarmCmdValue(aid) {
    return { alarmID: String(aid) };
  }

  async function netbotGet(item, value, { timeoutMs } = {}) {
    const body = { mtype: "get", data: { item } };
    if (value) body.data.value = value;
    const data = await api("/api/v1/netbot", { method: "POST", body, timeoutMs });
    return data.result?.data ?? data.result;
  }

  async function confirmAction(message) {
    if (!state.settings.confirmDestructive) return true;
    return window.confirm(message);
  }

  async function testConnection() {
    const health = await api("/api/health");
    state.cache.health = health;
    if (!state.settings.token) {
      setConnected(false, "Token required for data");
      return health;
    }
    await api("/api/v1/mobile/sysInfo");
    setConnected(true, health.netbotBridge?.ok ? "Bridge OK" : "Bridge down");
    return health;
  }

  async function refreshOverview() {
    const [sysInfo, hostsData, alarmsData, policiesData, health] = await Promise.all([
      mobile("sysInfo"),
      mobile("hosts"),
      mobile("alarms"),
      mobile("policies"),
      api("/api/health"),
    ]);
    state.cache.sysInfo = sysInfo;
    state.cache.hosts = hostsData.hosts || [];
    state.cache.alarms = alarmsData.alarms || [];
    state.cache.policies = policiesData.policies || [];
    state.cache.health = health;
    renderOverview();
    setConnected(true, health.netbotBridge?.ok ? "Bridge OK" : "Bridge down");
  }

  async function refreshDevices() {
    const data = await mobile("hosts");
    state.cache.hosts = data.hosts || [];
    renderDevices();
  }

  async function refreshAlarms() {
    const data = await mobile("alarms");
    state.cache.alarms = data.alarms || [];
    renderAlarms();
    if (state.view === "overview") renderOverviewAlarms();
  }

  async function refreshRules() {
    const [policies, exceptions] = await Promise.all([
      mobile("policies"),
      mobile("exceptions"),
    ]);
    state.cache.policies = policies.policies || [];
    state.cache.exceptions = exceptions.exceptions || exceptions.list || [];
    renderRules();
  }

  async function refreshNetwork() {
    const [networkConfig, vpn] = await Promise.all([
      mobile("networkConfig").catch(() => ({})),
      mobile("vpnProfiles").catch(() => ({})),
    ]);
    state.cache.networkConfig = networkConfig;
    state.cache.vpnProfiles = vpn.profiles || vpn.vpnProfiles || vpn.list || [];
    renderNetwork();
    loadNetworkStatus();
  }

  async function loadNetworkStatus() {
    state.networkStatusPending = true;
    renderNetworkStats();
    try {
      const status = await netbotGet("networkStatus", null, { timeoutMs: 8000 });
      state.cache.networkStatus = status || {};
    } catch {
      // Speed test data is optional; keep page usable without it.
    } finally {
      state.networkStatusPending = false;
      if (state.view === "network") renderNetworkStats();
    }
  }

  async function refreshTools() {
    const data = await api("/api/v1/scripts");
    const select = $("#tool-script");
    select.innerHTML = (data.scripts || [])
      .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
      .join("");
  }

  async function refreshCurrentView() {
    if (state.view === "settings") {
      return;
    }
    if (!hasToken()) {
      setConnected(false, "Save bearer token in Settings");
      return;
    }
    setBusy(true);
    try {
      if (state.view !== "network") {
        await testConnection();
      } else {
        const health = await api("/api/health");
        state.cache.health = health;
        setConnected(true, health.netbotBridge?.ok ? "Bridge OK" : "Bridge down");
      }
      switch (state.view) {
        case "overview":
          await refreshOverview();
          break;
        case "devices":
          await refreshDevices();
          break;
        case "alarms":
          await refreshAlarms();
          break;
        case "rules":
          await refreshRules();
          break;
        case "network":
          await refreshNetwork();
          break;
        case "tools":
          await refreshTools();
          break;
        default:
          break;
      }
    } catch (err) {
      setConnected(false, err.message);
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function renderOverview() {
    const sys = state.cache.sysInfo || {};
    const hosts = state.cache.hosts.length;
    const alarms = state.cache.alarms.filter((a) => a.state === "active").length;
    const policies = state.cache.policies.length;
    const bridgeOk = state.cache.health?.netbotBridge?.ok;

    $("#overview-stats").innerHTML = [
      statCard("Devices", hosts, "On LAN"),
      statCard("Active alarms", alarms, `${state.cache.alarms.length} total`),
      statCard("Policies", policies, "Firewall rules"),
      statCard("Bridge", bridgeOk ? "Online" : "Offline", bridgeOk ? "Netbot ready" : "Check service"),
    ].join("");

    const memPct = sys.mem != null ? `${(Number(sys.mem) * 100).toFixed(0)}%` : "—";
    const totalMem = sys.totalMem != null ? `${Number(sys.totalMem).toFixed(0)} MB` : "—";
    $("#overview-sysinfo").innerHTML = `
      <div class="detail-grid">
        ${detail("CPU load", `${sys.load1 ?? "—"} / ${sys.load5 ?? "—"} / ${sys.load15 ?? "—"}`)}
        ${detail("Memory", `${memPct} of ${totalMem}`)}
        ${detail("Uptime", fmtUptime(sys.uptime))}
        ${detail("Kernel", sys.kernelVersion || "—")}
        ${detail("Node", sys.nodeVersion || "—")}
        ${detail("Updated", fmtDate(sys.timestamp))}
      </div>`;

    renderOverviewAlarms();
  }

  function renderOverviewAlarms() {
    const rows = state.cache.alarms.slice(0, 8);
    $("#overview-alarms").innerHTML = rows.length
      ? alarmTableHtml(rows, { compact: true, actions: true })
      : `<div class="empty">No alarms</div>`;
    bindAlarmActions($("#overview-alarms"));
  }

  function statCard(label, value, sub) {
    return `
      <div class="stat-card">
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-value">${esc(value)}</div>
        <div class="stat-sub">${esc(sub)}</div>
      </div>`;
  }

  function detail(k, v) {
    return `<div class="detail-item"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  }

  function renderDevices() {
    const q = ($("#device-search").value || "").toLowerCase();
    const sort = $("#device-sort").value;
    let hosts = [...state.cache.hosts];
    if (q) {
      hosts = hosts.filter((h) =>
        [hostName(h), h.ip, h.mac, h.macVendor, h.intf]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }
    hosts.sort((a, b) => {
      if (sort === "ip") return String(a.ip).localeCompare(String(b.ip));
      if (sort === "name") return hostName(a).localeCompare(hostName(b));
      return Number(b.lastActive || 0) - Number(a.lastActive || 0);
    });
    $("#device-count").textContent = String(hosts.length);
    $("#devices-table").innerHTML = hosts.length
      ? `<table><thead><tr>
          <th>Name</th><th>IP</th><th>MAC</th><th>Vendor</th><th>Interface</th><th>Last active</th>
        </tr></thead><tbody>${hosts
          .map(
            (h) => `<tr data-ip="${esc(h.ip)}">
              <td>${esc(hostName(h))}</td>
              <td class="mono">${esc(h.ip)}</td>
              <td class="mono">${esc(h.mac || "—")}</td>
              <td>${esc(h.macVendor || "—")}</td>
              <td>${esc(h.intf || "—")}</td>
              <td>${fmtDate(h.lastActive)}</td>
            </tr>`
          )
          .join("")}</tbody></table>`
      : `<div class="empty">No devices match</div>`;

    $("#devices-table").querySelectorAll("tbody tr").forEach((row) => {
      row.addEventListener("click", () => openDeviceModal(row.dataset.ip));
    });
  }

  async function openDeviceModal(ip) {
    const host = state.cache.hosts.find((h) => h.ip === ip);
    if (!host) return;
    $("#device-modal-title").textContent = hostName(host);
    let local = null;
    try {
      local = await api(`/api/v1/local/host/${encodeURIComponent(ip)}`);
    } catch {
      local = null;
    }
    const fields = { ...host, ...(local?.data || local || {}) };
    $("#device-modal-body").innerHTML = `
      <div class="detail-grid">${Object.entries(fields)
        .slice(0, 24)
        .map(([k, v]) => detail(k, typeof v === "object" ? JSON.stringify(v) : v))
        .join("")}</div>`;
    $("#device-modal").classList.add("show");
  }

  function alarmTableHtml(alarms, { compact = false, actions = true } = {}) {
    return `<table><thead><tr>
      <th>State</th><th>Type</th><th>Device</th><th>Message</th><th>Time</th>
      ${actions ? "<th>Actions</th>" : ""}
    </tr></thead><tbody>${alarms
      .map((a) => {
        const device = a["p.device.name"] || a.device || "—";
        const actionCell = actions
          ? `<td><div class="btn-group">
              <button class="btn btn-sm" data-alarm-cmd="alarm:block" data-aid="${esc(a.aid)}">Block</button>
              <button class="btn btn-sm" data-alarm-cmd="alarm:allow" data-aid="${esc(a.aid)}">Allow</button>
              <button class="btn btn-sm" data-alarm-cmd="alarm:ignore" data-aid="${esc(a.aid)}">Ignore</button>
              <button class="btn btn-sm btn-danger" data-alarm-cmd="alarm:delete" data-aid="${esc(a.aid)}">Delete</button>
            </div></td>`
          : "";
        return `<tr>
          <td><span class="badge ${a.state === "active" ? "active" : "muted"}">${esc(a.state)}</span></td>
          <td>${esc((a.type || "").replace(/^ALARM_/, ""))}</td>
          <td>${esc(device)}</td>
          <td>${esc(a.message || "—")}</td>
          <td>${fmtDate(a.alarmTimestamp || a.timestamp)}</td>
          ${actionCell}
        </tr>`;
      })
      .join("")}</tbody></table>`;
  }

  function renderAlarms() {
    const q = ($("#alarm-search").value || "").toLowerCase();
    const stateFilter = $("#alarm-state").value;
    let alarms = [...state.cache.alarms];
    if (stateFilter) alarms = alarms.filter((a) => a.state === stateFilter);
    if (q) {
      alarms = alarms.filter((a) =>
        [a.type, a.message, a["p.device.name"], a.aid, a.state]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }
    $("#alarms-table").innerHTML = alarms.length
      ? alarmTableHtml(alarms)
      : `<div class="empty">No alarms match</div>`;
    bindAlarmActions($("#alarms-table"));
  }

  function bindAlarmActions(root) {
    root.querySelectorAll("[data-alarm-cmd]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const item = btn.dataset.alarmCmd;
        const aid = btn.dataset.aid;
        if (!aid) {
          toast("Missing alarm ID", "error");
          return;
        }
        setBusy(true);
        try {
          await netbotCmd(item, alarmCmdValue(aid));
          toast(`${item.replace("alarm:", "")} → ${aid}`);
          await refreshAlarms();
          if (state.view === "overview") await refreshOverview();
        } catch (err) {
          toast(err.message, "error");
        } finally {
          setBusy(false);
        }
      });
    });
  }

  function renderRules() {
    const pq = ($("#policy-search").value || "").toLowerCase();
    const eq = ($("#exception-search").value || "").toLowerCase();
    let policies = state.cache.policies;
    let exceptions = state.cache.exceptions;
    if (pq) {
      policies = policies.filter((p) =>
        JSON.stringify(p).toLowerCase().includes(pq)
      );
    }
    if (eq) {
      exceptions = exceptions.filter((e) =>
        JSON.stringify(e).toLowerCase().includes(eq)
      );
    }
    $("#policy-count").textContent = String(policies.length);
    $("#exception-count").textContent = String(exceptions.length);

    $("#policies-table").innerHTML = policies.length
      ? `<table><thead><tr>
          <th>Action</th><th>Target</th><th>Type</th><th>Direction</th><th>Disabled</th>
        </tr></thead><tbody>${policies
          .slice(0, 200)
          .map(
            (p) => `<tr>
              <td>${esc(p.action || "—")}</td>
              <td class="mono">${esc(p.target || "—")}</td>
              <td>${esc(p.type || "—")}</td>
              <td>${esc(p.direction || "—")}</td>
              <td>${p.disabled ? "yes" : "no"}</td>
            </tr>`
          )
          .join("")}</tbody></table>`
      : `<div class="empty">No policies</div>`;

    $("#exceptions-table").innerHTML = exceptions.length
      ? `<table><thead><tr>
          <th>Name</th><th>Type</th><th>Target</th><th>Notes</th>
        </tr></thead><tbody>${exceptions
          .slice(0, 200)
          .map((e) => {
            const target =
              e.target ||
              e.dest ||
              e.domain ||
              e.ip ||
              e.remote ||
              JSON.stringify(e).slice(0, 80);
            return `<tr>
              <td>${esc(e.name || e.ename || e.id || "—")}</td>
              <td>${esc(e.type || e.category || "—")}</td>
              <td class="mono">${esc(target)}</td>
              <td>${esc(e.note || e.notes || "—")}</td>
            </tr>`;
          })
          .join("")}</tbody></table>`
      : `<div class="empty">No exceptions</div>`;
  }

  function formatSpeed(bps) {
    const v = Number(bps);
    if (!Number.isFinite(v) || v <= 0) return "—";
    return `${(v / 1e6).toFixed(0)} Mbps`;
  }

  function onOffBadge(enabled) {
    return enabled
      ? '<span class="badge ok">On</span>'
      : '<span class="badge muted">Off</span>';
  }

  function typeBadge(type) {
    const t = String(type || "other").toLowerCase();
    const cls = t === "wan" ? "wan" : t === "lan" ? "lan" : "vpn";
    return `<span class="badge ${cls}">${esc(type || "—")}</span>`;
  }

  function kvRow(label, value) {
    return `<div class="kv-row"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
  }

  function collectInterfaces(cfg) {
    const rows = [];
    const iface = cfg.interface || {};

    for (const [id, data] of Object.entries(iface.phy || {})) {
      const meta = data.meta || {};
      rows.push({
        id,
        name: meta.name || id,
        type: meta.type || "phy",
        ipv4: data.ipv4 || (data.dhcp ? "DHCP" : "—"),
        enabled: data.enabled !== false,
        detail: data.dhcp ? "DHCP client" : "Static",
        members: id,
      });
    }

    for (const [id, data] of Object.entries(iface.bridge || {})) {
      const meta = data.meta || {};
      rows.push({
        id,
        name: meta.name || id,
        type: meta.type || "lan",
        ipv4: data.ipv4 || "—",
        enabled: data.enabled !== false,
        detail: "Bridge",
        members: (data.intf || []).join(", ") || "—",
      });
    }

    for (const [id, data] of Object.entries({ ...(iface.openvpn || {}), ...(iface.wireguard || {}), ...(iface.amneziawg || {}) })) {
      const meta = data.meta || {};
      rows.push({
        id,
        name: meta.name || id,
        type: meta.type || data.type || "vpn",
        ipv4: data.ipv4 || "—",
        enabled: data.enabled === true,
        detail: data.instance || data.type || "VPN",
        members: id,
      });
    }

    return rows;
  }

  function renderNetworkStats() {
    const cfg = state.cache.networkConfig || {};
    const status = state.cache.networkStatus || {};
    const routing = cfg.routing || {};
    const defaultWan = routing.global?.default?.viaIntf || "—";
    const speed = status.speedtest || {};
    const lanCount = Object.keys(cfg.dhcp || {}).length;
    const ifaceCount = collectInterfaces(cfg).length;
    const pending = state.networkStatusPending;
    const speedHint = pending
      ? "Loading speed test…"
      : speed.server?.name || (speed.download ? "Last speed test" : "Speed test unavailable");

    $("#network-stats").innerHTML = [
      statCard("Default WAN", defaultWan, "Primary uplink"),
      statCard("Download", pending ? "…" : formatSpeed(speed.download), speedHint),
      statCard(
        "Upload",
        pending ? "…" : formatSpeed(speed.upload),
        speed.server?.latency ? `${Number(speed.server.latency).toFixed(1)} ms latency` : ""
      ),
      statCard("LANs", lanCount, `${ifaceCount} interfaces`),
    ].join("");
  }

  function renderNetwork() {
    const cfg = state.cache.networkConfig || {};
    const status = state.cache.networkStatus || {};
    const routing = cfg.routing || {};
    const nat = cfg.nat || {};
    const defaultWan = routing.global?.default?.viaIntf || "—";
    const ifaces = collectInterfaces(cfg);

    renderNetworkStats();

    $("#network-interfaces").innerHTML = ifaces.length
      ? `<table><thead><tr>
          <th>Name</th><th>Type</th><th>Address</th><th>Members</th><th>Status</th><th>Notes</th>
        </tr></thead><tbody>${ifaces
          .map(
            (i) => `<tr>
              <td><strong>${esc(i.name)}</strong><div class="mono" style="color:var(--muted);font-size:0.78rem">${esc(i.id)}</div></td>
              <td>${typeBadge(i.type)}</td>
              <td class="mono">${esc(i.ipv4)}</td>
              <td class="mono">${esc(i.members)}</td>
              <td>${onOffBadge(i.enabled)}</td>
              <td>${esc(i.detail)}</td>
            </tr>`
          )
          .join("")}</tbody></table>`
      : `<div class="empty">No interface data</div>`;

    const dhcpRows = Object.entries(cfg.dhcp || {});
    $("#network-dhcp").innerHTML = dhcpRows.length
      ? `<table><thead><tr>
          <th>Bridge</th><th>Subnet</th><th>Pool</th><th>Gateway</th><th>Lease</th>
        </tr></thead><tbody>${dhcpRows
          .map(([br, d]) => {
            const range = d.range ? `${d.range.from} – ${d.range.to}` : "—";
            const lease = d.lease ? `${Math.round(Number(d.lease) / 3600)}h` : "—";
            return `<tr>
              <td><strong>${esc(br)}</strong></td>
              <td class="mono">${esc(d.subnetMask || "—")}</td>
              <td class="mono">${esc(range)}</td>
              <td class="mono">${esc(d.gateway || "—")}</td>
              <td>${esc(lease)}</td>
            </tr>`;
          })
          .join("")}</tbody></table>`
      : `<div class="empty">No DHCP pools</div>`;

    const wanIface = (cfg.interface?.phy || {})[defaultWan] || {};
    const wanExtra = wanIface.extra || {};
    const natRows = Object.entries(nat);
    $("#network-wan").innerHTML = `<div class="kv-list">
      ${kvRow("Default route", defaultWan)}
      ${kvRow("WAN name", wanIface.meta?.name || defaultWan)}
      ${kvRow("Ping monitor", wanExtra.pingTestEnabled ? (wanExtra.pingTestIP || []).join(", ") : "Off")}
      ${kvRow("DNS monitor", wanExtra.dnsTestEnabled ? wanExtra.dnsTestDomain || "On" : "Off")}
      ${kvRow("Gigabit", state.networkStatusPending ? "…" : status.gigabit ? "Yes" : "No")}
      ${kvRow("Config version", cfg.version ?? "—")}
      ${natRows.length ? kvRow("NAT rules", natRows.map(([k]) => k).join(", ")) : kvRow("NAT rules", "—")}
    </div>`;

    const serviceBlocks = [];
    const sshd = cfg.sshd || {};
    for (const [intf, s] of Object.entries(sshd)) {
      serviceBlocks.push(`<div class="toggle-row">
        <div><div class="toggle-label">SSH on ${esc(intf)}</div><div class="toggle-desc">Remote shell access</div></div>
        ${onOffBadge(s.enabled)}
      </div>`);
    }
    const upnp = cfg.upnp || {};
    for (const [br, s] of Object.entries(upnp)) {
      serviceBlocks.push(`<div class="toggle-row">
        <div><div class="toggle-label">UPnP on ${esc(br)}</div><div class="toggle-desc">Via ${esc(s.extIntf || "WAN")} · NAT-PMP ${s.enableNatpmp ? "on" : "off"}</div></div>
        ${onOffBadge(s.enableUpnp)}
      </div>`);
    }
    const mdns = cfg.mdns_reflector || {};
    for (const [intf, s] of Object.entries(mdns)) {
      serviceBlocks.push(`<div class="toggle-row">
        <div><div class="toggle-label">mDNS on ${esc(intf)}</div><div class="toggle-desc">Local discovery reflector</div></div>
        ${onOffBadge(s.enabled)}
      </div>`);
    }
    $("#network-services").innerHTML = serviceBlocks.length
      ? `<div class="service-grid">${serviceBlocks.join("")}</div>`
      : `<div class="empty">No service settings</div>`;

    const vpns = state.cache.vpnProfiles;
    $("#vpn-table").innerHTML = Array.isArray(vpns) && vpns.length
      ? `<table><thead><tr>
          <th>Profile</th><th>Status</th><th>Actions</th>
        </tr></thead><tbody>${vpns
          .map((v, i) => {
            const name = v.name || v.profileName || v.id || `Profile ${i + 1}`;
            const statusLabel = v.status || v.state || (v.enabled ? "enabled" : "disabled");
            return `<tr>
              <td>${esc(name)}</td>
              <td>${onOffBadge(v.enabled || statusLabel === "enabled")}</td>
              <td><div class="btn-group">
                <button class="btn btn-sm" data-vpn-cmd="vpn:start" data-name="${esc(name)}">Start</button>
                <button class="btn btn-sm" data-vpn-cmd="vpn:stop" data-name="${esc(name)}">Stop</button>
              </div></td>
            </tr>`;
          })
          .join("")}</tbody></table>`
      : `<div class="empty">No VPN client profiles configured</div>`;

    $("#vpn-table").querySelectorAll("[data-vpn-cmd]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        setBusy(true);
        try {
          await netbotCmd(btn.dataset.vpnCmd, { name: btn.dataset.name });
          toast(`${btn.dataset.vpnCmd} ${btn.dataset.name}`);
          await refreshNetwork();
        } catch (err) {
          toast(err.message, "error");
        } finally {
          setBusy(false);
        }
      });
    });
  }

  function updateAuthBanner() {
    const banner = $("#auth-banner");
    if (!banner) return;
    banner.hidden = state.view === "settings" || hasToken();
  }

  function switchView(name, { refresh = true } = {}) {
    state.view = name;
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.view === name);
    });
    document.querySelectorAll(".view").forEach((el) => {
      el.classList.toggle("active", el.id === `view-${name}`);
    });
    $("#page-title").textContent = VIEW_TITLES[name] || name;
    updateAuthBanner();
    if (refresh && name !== "settings") {
      refreshCurrentView();
    }
  }

  function applySettingsToForm() {
    $("#setting-api-url").value = state.settings.apiUrl;
    $("#setting-token").value = state.settings.token;
    $("#setting-refresh").value = String(state.settings.refreshSec);
    $("#setting-confirm").checked = !!state.settings.confirmDestructive;
    $("#setting-compact").checked = !!state.settings.compact;
    $("#auto-refresh-toggle").checked = state.settings.refreshSec > 0;
    document.body.classList.toggle("compact", !!state.settings.compact);
    scheduleAutoRefresh();
  }

  function scheduleAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    const sec = Number(state.settings.refreshSec);
    if (sec > 0 && state.settings.token) {
      state.refreshTimer = setInterval(() => {
        if (state.view !== "settings" && state.view !== "tools") {
          refreshCurrentView();
        }
      }, sec * 1000);
    }
  }

  async function runAlarmBulk(item) {
    if (!(await confirmAction(`Run ${item}? This affects all matching alarms.`))) return;
    setBusy(true);
    try {
      await netbotCmd(item, {});
      toast(item);
      await refreshAlarms();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function bindEvents() {
    $("#nav").addEventListener("click", (ev) => {
      const item = ev.target.closest(".nav-item");
      if (item?.dataset.view) switchView(item.dataset.view);
    });

    $("#btn-refresh").addEventListener("click", () => refreshCurrentView());
    $("#device-search").addEventListener("input", renderDevices);
    $("#device-sort").addEventListener("change", renderDevices);
    $("#alarm-search").addEventListener("input", renderAlarms);
    $("#alarm-state").addEventListener("change", renderAlarms);
    $("#policy-search").addEventListener("input", renderRules);
    $("#exception-search").addEventListener("input", renderRules);

    $("#settings-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      state.settings.apiUrl = $("#setting-api-url").value.trim().replace(/\/$/, "");
      state.settings.token = $("#setting-token").value.trim();
      state.settings.refreshSec = Math.max(0, Number($("#setting-refresh").value) || 0);
      state.settings.confirmDestructive = $("#setting-confirm").checked;
      state.settings.compact = $("#setting-compact").checked;
      saveSettings();
      applySettingsToForm();
      updateAuthBanner();
      toast("Settings saved");
      switchView("overview", { refresh: true });
    });

    $("#setting-confirm").addEventListener("change", () => {
      state.settings.confirmDestructive = $("#setting-confirm").checked;
      saveSettings();
    });
    $("#setting-compact").addEventListener("change", () => {
      state.settings.compact = $("#setting-compact").checked;
      saveSettings();
      document.body.classList.toggle("compact", state.settings.compact);
    });

    $("#auto-refresh-toggle").addEventListener("change", () => {
      state.settings.refreshSec = $("#auto-refresh-toggle").checked ? 30 : 0;
      $("#setting-refresh").value = String(state.settings.refreshSec);
      saveSettings();
      scheduleAutoRefresh();
    });

    $("#btn-test-connection").addEventListener("click", async () => {
      syncSettingsFromForm();
      setBusy(true);
      try {
        const h = await testConnection();
        toast(`Health OK · bridge ${h.netbotBridge?.ok ? "up" : "down"}`);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        setBusy(false);
      }
    });

    $("#btn-clear-settings").addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      state.settings = loadSettings();
      applySettingsToForm();
      toast("Settings cleared");
    });

    document.body.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "refresh-hosts") return refreshDevices();
      if (action === "refresh-alarms") return refreshAlarms();
      if (action === "alarm-delete-active-all") return runAlarmBulk("alarm:deleteActiveAll");
      if (action === "alarm-ignore-all") return runAlarmBulk("alarm:ignoreAll");
    });

    $("#btn-run-script").addEventListener("click", async () => {
      const script = $("#tool-script").value;
      const args = ($("#tool-args").value || "").trim().split(/\s+/).filter(Boolean);
      const sudo = $("#tool-sudo").checked;
      setBusy(true);
      $("#tool-output").textContent = "Running…";
      try {
        const result = await api("/api/v1/run", {
          method: "POST",
          body: { script, args, sudo },
        });
        $("#tool-output").textContent = result.stdout || JSON.stringify(result, null, 2);
        toast(`Ran ${script}`);
      } catch (err) {
        $("#tool-output").textContent = err.message;
        toast(err.message, "error");
      } finally {
        setBusy(false);
      }
    });

    $("#btn-system-probe").addEventListener("click", async () => {
      setBusy(true);
      try {
        const result = await api("/api/v1/system");
        $("#tool-output").textContent = result.stdout || JSON.stringify(result, null, 2);
      } catch (err) {
        toast(err.message, "error");
      } finally {
        setBusy(false);
      }
    });

    $("#btn-admin-restart").addEventListener("click", async () => {
      if (!(await confirmAction("Restart firewalla-api and netbot-bridge?"))) return;
      setBusy(true);
      try {
        await api("/api/v1/admin/restart", { method: "POST", body: {} });
        toast("Restart scheduled");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        setBusy(false);
      }
    });

    $("#device-modal-close").addEventListener("click", () => {
      $("#device-modal").classList.remove("show");
    });
    $("#device-modal").addEventListener("click", (ev) => {
      if (ev.target.id === "device-modal") $("#device-modal").classList.remove("show");
    });
  }

  function init() {
    bindEvents();
    applySettingsToForm();
    if (state.settings.token) {
      switchView("overview", { refresh: true });
    } else {
      setConnected(false, "Save bearer token in Settings");
      switchView("settings", { refresh: false });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
