type Metrics = {
  cpu: number;
  ram: number;
  disk: number;
  io: number;
  errors: number;
  updatedAt: string;
  source?: "demo" | "ssh" | "local" | "monitor";
};

type Verdict = {
  emoji: string;
  statusText: string;
  hint: string;
  actions: string[];
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const el = {
  cpuVal: $("cpuVal"),
  ramVal: $("ramVal"),
  cpuBar: $("cpuBar"),
  ramBar: $("ramBar"),
  diskVal: $("diskVal"),
  diskBar: $("diskBar"),
  ioVal: $("ioVal"),
  ioBar: $("ioBar"),
  emoji: $("emoji"),
  statusText: $("statusText"),
  statusHint: $("statusHint"),
  updatedAt: $("updatedAt"),
  awsTermHost: $("awsTerm"),
  metricsSource: $("metricsSource"),
  monitorUrl: $("monitorUrl") as unknown as HTMLInputElement,
  btnUseLocal: $("btnUseLocal") as unknown as HTMLButtonElement,
  btnUseMonitor: $("btnUseMonitor") as unknown as HTMLButtonElement,
  monitorState: $("monitorState"),
  agentLog: $("agentLog"),
  agentLogState: $("agentLogState"),
  btnLogClear: $("btnLogClear") as unknown as HTMLButtonElement,
  btnLogCsv: $("btnLogCsv") as unknown as HTMLButtonElement,
  aiLog: $("aiLog"),
  btnAiClear: $("btnAiClear") as unknown as HTMLButtonElement,
  btnSelfHeal: $("btnSelfHeal") as unknown as HTMLButtonElement,
  selfHealState: $("selfHealState")
};

let opsWs: WebSocket | null = null;
let awsWs: WebSocket | null = null;

let agentLogEs: EventSource | null = null;
let agentLogLines: string[] = [];
const MAX_LOG_LINES = 200;

let aiLines: string[] = [];
const MAX_AI_LINES = 200;

type SelfHealUiMode = "off" | "dry-run" | "armed";
let selfHealMode: SelfHealUiMode = "off";

function renderAiLog() {
  if (!el.aiLog) return;
  el.aiLog.textContent = aiLines.join("\n");
  el.aiLog.scrollTop = el.aiLog.scrollHeight;
}

function pushAiLine(line: string) {
  aiLines.push(line);
  while (aiLines.length > MAX_AI_LINES) aiLines.shift();
  renderAiLog();
}

function updateSelfHealUi(state?: { enabled: boolean; mode: "dry-run" | "armed"; rateLimited?: boolean; isolated?: boolean }) {
  if (!el.btnSelfHeal || !el.selfHealState) return;

  if (!state) {
    const label = selfHealMode === "off" ? "OFF" : selfHealMode.toUpperCase();
    el.selfHealState.textContent = label;
    el.btnSelfHeal.textContent = label;
    el.btnSelfHeal.classList.toggle("active", selfHealMode !== "off");
    return;
  }

  selfHealMode = state.enabled ? (state.mode === "armed" ? "armed" : "dry-run") : "off";
  const flags = [state.rateLimited ? "RATE" : null, state.isolated ? "ISOLATED" : null]
    .filter(Boolean)
    .join(" ");
  const label = selfHealMode.toUpperCase();
  el.selfHealState.textContent = `${label}${flags ? " · " + flags : ""}`;
  el.btnSelfHeal.textContent = label;
  el.btnSelfHeal.classList.toggle("active", selfHealMode !== "off");
}

type OpsMsg =
  | { type: "status"; level: "info" | "error"; message: string }
  | { type: "metrics"; metrics: Metrics }
  | { type: "ai"; event: any }
  | { type: "selfheal"; enabled: boolean; mode: "dry-run" | "armed"; rateLimited: boolean; isolated: boolean };

type OpsSourceMsg =
  | { type: "setSource"; source: "local" }
  | { type: "setSource"; source: "monitor"; url: string };

type OpsClientMsg = OpsSourceMsg | { type: "setSelfHeal"; enabled: boolean; mode: "dry-run" | "armed"; rateLimitSeconds?: number };

type AwsMsg =
  | { type: "status"; level: "info" | "error"; message: string }
  | { type: "term"; data: string };

function g(name: string): any {
  return (globalThis as any)?.[name];
}

let chart: any | null = null;
const chartBuffer = {
  labels: [] as string[],
  cpu: [] as number[],
  ram: [] as number[],
  disk: [] as number[],
  io: [] as number[]
};
const MAX_POINTS = 40;

let awsTerm: any | null = null;
let fitAddon: any | null = null;
let awsLineBuffer = "";

let sshTerm: any | null = null;
let sshFit: any | null = null;
let sshWs: WebSocket | null = null;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function setBar(bar: HTMLElement, value: number, max = 100) {
  const p = clamp((value / max) * 100, 0, 100);
  bar.style.width = `${p}%`;
}

function nowIso() {
  return new Date().toISOString();
}

function verdictFromMetrics(m: Metrics): Verdict {
  const heavy = m.cpu >= 85 || m.ram >= 85 || m.disk >= 90 || m.io >= 85;
  const warn = m.cpu >= 75 || m.ram >= 75 || m.disk >= 85 || m.io >= 75;

  if (m.errors >= 25 || heavy) {
    return {
      emoji: "😡",
      statusText: "위험",
      hint: "즉시 점검이 필요합니다.",
      actions: [
        "부하 분산",
        "프로세스/서비스 점검",
        "리소스 과다 사용 원인 확인"
      ]
    };
  }

  if (m.errors >= 12 || warn) {
    return {
      emoji: "🤨",
      statusText: "주의",
      hint: "추세를 보고 선제 대응을 권장합니다.",
      actions: [
        "CPU/RAM/IO 상위 프로세스 확인",
        "스케일아웃/자원 증설 검토",
        "배포/로그 변화 확인"
      ]
    };
  }

  if (m.cpu <= 35 && m.ram <= 35 && m.disk <= 70 && m.io <= 20 && m.errors <= 2) {
    return {
      emoji: "😎",
      statusText: "최상",
      hint: "운영이 아주 안정적입니다.",
      actions: ["유지", "에너지 최적화(저부하 구간 전력 절감 정책 적용)"]
    };
  }

  return {
    emoji: "🙂",
    statusText: "정상",
    hint: "모니터링 유지",
    actions: ["정상 운영", "추세 변화 감시"]
  };
}

function setVerdictUI(v: Verdict, m: Metrics) {
  el.emoji.textContent = v.emoji;
  el.statusText.textContent = v.statusText;
  el.statusHint.textContent = v.hint;
  const ts = new Date(m.updatedAt).toLocaleString();
  el.updatedAt.textContent = `업데이트: ${ts}`;
}

function render(m: Metrics) {
  const src = m.source ?? "unknown";
  el.metricsSource.textContent = `source: ${src}`;

  el.cpuVal.textContent = String(Math.round(m.cpu));
  el.ramVal.textContent = String(Math.round(m.ram));
  el.diskVal.textContent = String(Math.round(m.disk));
  el.ioVal.textContent = String(Math.round(m.io));

  setBar(el.cpuBar, m.cpu);
  setBar(el.ramBar, m.ram);
  setBar(el.diskBar, m.disk);
  setBar(el.ioBar, m.io);

  const verdict = verdictFromMetrics(m);
  setVerdictUI(verdict, m);
}

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function demoMetrics(): Metrics {
  let cpu = randomBetween(18, 55);
  let ram = randomBetween(22, 58);
  let disk = randomBetween(35, 75);
  let io = randomBetween(5, 35);
  let errors = Math.round(randomBetween(0, 5));

  return {
    cpu, ram, disk, io, errors,
    updatedAt: nowIso(),
    source: "demo"
  };
}

function initChart() {
  const canvas = document.getElementById("chartMain") as HTMLCanvasElement | null;
  const ChartLib = g("Chart");
  if (!canvas || !ChartLib) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  chart = new ChartLib(ctx, {
    type: "line",
    data: {
      labels: chartBuffer.labels,
      datasets: [
        { label: "CPU%", data: chartBuffer.cpu, borderColor: "rgba(80,130,255,0.95)", tension: 0.25, pointRadius: 0 },
        { label: "RAM%", data: chartBuffer.ram, borderColor: "rgba(0,255,190,0.9)", tension: 0.25, pointRadius: 0 },
        { label: "DISK%", data: chartBuffer.disk, borderColor: "rgba(255,170,60,0.9)", tension: 0.25, pointRadius: 0 },
        { label: "IO%", data: chartBuffer.io, borderColor: "rgba(255,120,220,0.9)", tension: 0.25, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "rgba(255,255,255,0.8)" } }
      },
      scales: {
        x: { ticks: { color: "rgba(255,255,255,0.6)" }, grid: { color: "rgba(255,255,255,0.08)" } },
        y: { ticks: { color: "rgba(255,255,255,0.6)" }, grid: { color: "rgba(255,255,255,0.08)" } }
      }
    }
  });
}

function pushChart(m: Metrics) {
  const t = new Date(m.updatedAt);
  const stamp = `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}`;

  chartBuffer.labels.push(stamp);
  chartBuffer.cpu.push(m.cpu);
  chartBuffer.ram.push(m.ram);
  chartBuffer.disk.push(m.disk);
  chartBuffer.io.push(m.io);

  while (chartBuffer.labels.length > MAX_POINTS) {
    chartBuffer.labels.shift();
    chartBuffer.cpu.shift();
    chartBuffer.ram.shift();
    chartBuffer.disk.shift();
    chartBuffer.io.shift();
  }

  if (chart) chart.update("none");
}

function initAwsTerminal() {
  if (!el.awsTermHost) return;

  const TerminalCtor = g("Terminal");
  if (!TerminalCtor) {
    // CDN 로딩 지연/실패 대비: 짧게 재시도
    if (!el.awsTermHost.dataset.termRetry) {
      el.awsTermHost.dataset.termRetry = "1";
      el.awsTermHost.textContent = "터미널 로딩 중...";
      let tries = 0;
      const t = window.setInterval(() => {
        tries++;
        const T = g("Terminal");
        if (T) {
          window.clearInterval(t);
          delete el.awsTermHost.dataset.termRetry;
          el.awsTermHost.textContent = "";
          initAwsTerminal();
          return;
        }
        if (tries >= 50) {
          window.clearInterval(t);
          el.awsTermHost.textContent = "터미널 로드 실패(xterm.js). 새로고침하거나 네트워크/콘솔 오류를 확인하세요.";
        }
      }, 100);
    }
    return;
  }

  awsTerm = new TerminalCtor({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    theme: { background: "#00000000" }
  });

  const FitAddonLib = g("FitAddon");
  const Fit = (FitAddonLib && (FitAddonLib.FitAddon || FitAddonLib)) ?? null;
  fitAddon = Fit ? new Fit() : null;
  if (fitAddon) awsTerm.loadAddon(fitAddon);

  awsTerm.open(el.awsTermHost);
  if (fitAddon) fitAddon.fit();

  el.awsTermHost.addEventListener("mousedown", () => {
    try {
      awsTerm?.focus();
    } catch {
      // ignore
    }
  });

  try {
    awsTerm.focus();
  } catch {
    // ignore
  }

  awsTerm.writeln("SHELL 터미널 연결 중...\r\n");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  awsWs = new WebSocket(`${proto}://${location.host}/ws/aws`);

  awsWs.addEventListener("open", () => {
    awsTerm.writeln("연결됨. 명령을 입력하세요.\r\n");
    awsTerm.write("$ ");
    try {
      awsTerm.focus();
    } catch {
      // ignore
    }
  });

  awsWs.addEventListener("message", (ev) => {
    let msg: AwsMsg | null = null;
    try {
      msg = JSON.parse(String(ev.data)) as AwsMsg;
    } catch {
      return;
    }
    if (msg.type === "status") {
      awsTerm.writeln(`\r\n[${msg.level.toUpperCase()}] ${msg.message}\r\n`);
      awsTerm.write("$ ");
      return;
    }
    if (msg.type === "term") {
      awsTerm.write(msg.data.replace(/\n/g, "\r\n"));
      return;
    }
  });

  awsWs.addEventListener("close", () => {
    awsTerm.writeln("\r\n[INFO] 연결 종료\r\n");
  });

  awsTerm.onData((data: string) => {
    if (!awsWs || awsWs.readyState !== WebSocket.OPEN) return;
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const line = awsLineBuffer;
        awsLineBuffer = "";
        awsTerm.write("\r\n");
        awsWs.send(JSON.stringify({ type: "run", line }));
        awsTerm.write("$ ");
      } else if (ch === "\u007F") {
        // backspace
        if (awsLineBuffer.length > 0) {
          awsLineBuffer = awsLineBuffer.slice(0, -1);
          awsTerm.write("\b \b");
        }
      } else {
        awsLineBuffer += ch;
        awsTerm.write(ch);
      }
    }
  });
}

function connectOpsStream() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  opsWs = new WebSocket(`${proto}://${location.host}/ws/ops`);

  opsWs.addEventListener("open", () => {
    // restore last selection
    const saved = localStorage.getItem("monitorUrl") ?? "";
    if (saved && (el.monitorUrl.value?.trim?.() ?? "") === "") {
      el.monitorUrl.value = saved;
    }
    // default to local unless user explicitly selected monitor previously
    const lastSource = (localStorage.getItem("opsSource") as "local" | "monitor" | null) ?? "local";
    if (lastSource === "monitor" && (el.monitorUrl.value ?? "").trim()) {
      const msg: OpsSourceMsg = { type: "setSource", source: "monitor", url: el.monitorUrl.value.trim() };
      opsWs?.send(JSON.stringify(msg));
      el.monitorState.textContent = "EC2 연결 시도...";
      connectAgentLogsFromMonitorUrl(el.monitorUrl.value.trim());
    } else {
      const msg: OpsSourceMsg = { type: "setSource", source: "local" };
      opsWs?.send(JSON.stringify(msg));
      el.monitorState.textContent = "LOCAL";
      disconnectAgentLogs();
    }
  });

  opsWs.addEventListener("message", (ev) => {
    let msg: OpsMsg | null = null;
    try {
      msg = JSON.parse(String(ev.data)) as OpsMsg;
    } catch {
      return;
    }
    if (msg.type === "metrics") {
      render(msg.metrics);
      pushChart(msg.metrics);
    }
    if (msg.type === "status") {
      el.monitorState.textContent = msg.message;
    }
    if (msg.type === "ai") {
      const e = (msg as any).event ?? {};
      const sev = String(e.severity ?? "info").toUpperCase();
      const t = String(e.type ?? "event");
      const m = String(e.message ?? "");
      pushAiLine(`[${sev}] ${t}: ${m}`);
      if (e.executed?.mode) {
        pushAiLine(`  -> ${String(e.executed.mode).toUpperCase()} (${(e.executed.actions ?? []).length} actions)`);
      }
    }
    if (msg.type === "selfheal") {
      updateSelfHealUi(msg);
    }
  });

  opsWs.addEventListener("close", () => {
    // fallback: 데모
    const m = demoMetrics();
    render(m);
    pushChart(m);
    setTimeout(connectOpsStream, 1500);
  });
}

function clearChart() {
  chartBuffer.labels.length = 0;
  chartBuffer.cpu.length = 0;
  chartBuffer.ram.length = 0;
  chartBuffer.disk.length = 0;
  chartBuffer.io.length = 0;
  if (chart) chart.update("none");
}

function deriveLogsUrl(monitorUrl: string): string | null {
  try {
    const u = new URL(monitorUrl);
    // /monitor -> /logs, 그 외면 /logs로 강제
    u.pathname = u.pathname.endsWith("/monitor") ? u.pathname.replace(/\/monitor$/, "/logs") : "/logs";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function renderAgentLog() {
  if (!el.agentLog) return;
  el.agentLog.textContent = agentLogLines.join("\n");
  // scroll to bottom
  el.agentLog.scrollTop = el.agentLog.scrollHeight;
}

function csvEscape(v: string) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadText(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function exportAgentLogCsv() {
  const rows: string[] = [];
  rows.push(["idx", "ts", "message", "raw"].join(","));

  for (let i = 0; i < agentLogLines.length; i++) {
    const raw = agentLogLines[i] ?? "";
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/);
    const ts = m ? m[1] : "";
    const message = m ? m[2] : raw;
    rows.push(
      [
        csvEscape(String(i + 1)),
        csvEscape(ts),
        csvEscape(message),
        csvEscape(raw)
      ].join(",")
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `agent-logs-${stamp}.csv`;
  downloadText(filename, rows.join("\r\n"), "text/csv;charset=utf-8");
}

function disconnectAgentLogs() {
  if (agentLogEs) {
    try {
      agentLogEs.close();
    } catch {
      // ignore
    }
  }
  agentLogEs = null;
  if (el.agentLogState) el.agentLogState.textContent = "대기";
}

function connectAgentLogsFromMonitorUrl(monitorUrl: string) {
  const logsUrl = deriveLogsUrl(monitorUrl);
  if (!logsUrl) {
    if (el.agentLogState) el.agentLogState.textContent = "로그 URL 파싱 실패";
    return;
  }

  disconnectAgentLogs();
  if (el.agentLogState) el.agentLogState.textContent = "연결 중...";

  try {
    agentLogEs = new EventSource(logsUrl);
  } catch {
    if (el.agentLogState) el.agentLogState.textContent = "EventSource 생성 실패";
    agentLogEs = null;
    return;
  }

  agentLogEs.onopen = () => {
    if (el.agentLogState) el.agentLogState.textContent = "연결됨";
  };
  agentLogEs.onmessage = (ev) => {
    const line = String(ev.data ?? "");
    if (!line) return;
    agentLogLines.push(line);
    while (agentLogLines.length > MAX_LOG_LINES) agentLogLines.shift();
    renderAgentLog();
  };
  agentLogEs.onerror = () => {
    if (el.agentLogState) el.agentLogState.textContent = "연결 끊김";
    disconnectAgentLogs();
  };
}

function bootstrap() {
  initChart();
  connectOpsStream();
  initAwsTerminal();
  initSshTerminalAndUI();
  renderAiLog();
  updateSelfHealUi();
}

function sendOpsSource(msg: OpsSourceMsg) {
  localStorage.setItem("opsSource", msg.source);
  if (msg.source === "monitor") localStorage.setItem("monitorUrl", msg.url);
  clearChart();
  if (opsWs && opsWs.readyState === WebSocket.OPEN) {
    opsWs.send(JSON.stringify(msg));
  } else {
    el.monitorState.textContent = "OPS 연결 대기...";
  }
}

el.btnUseLocal.addEventListener("click", () => {
  el.monitorState.textContent = "LOCAL";
  sendOpsSource({ type: "setSource", source: "local" });
  disconnectAgentLogs();
});

el.btnUseMonitor.addEventListener("click", () => {
  const url = (el.monitorUrl.value ?? "").trim();
  if (!url) {
    el.monitorState.textContent = "EC2 /monitor URL을 입력하세요";
    return;
  }
  el.monitorState.textContent = "EC2 연결 시도...";
  sendOpsSource({ type: "setSource", source: "monitor", url });
  connectAgentLogsFromMonitorUrl(url);
});

el.btnLogClear?.addEventListener("click", () => {
  agentLogLines = [];
  renderAgentLog();
});

el.btnLogCsv?.addEventListener("click", () => {
  exportAgentLogCsv();
});

el.btnAiClear?.addEventListener("click", () => {
  aiLines = [];
  renderAiLog();
});

el.btnSelfHeal?.addEventListener("click", () => {
  if (!opsWs || opsWs.readyState !== WebSocket.OPEN) {
    pushAiLine("[WARN] OPS 연결이 없습니다.");
    return;
  }

  const next: SelfHealUiMode =
    selfHealMode === "off" ? "dry-run" : selfHealMode === "dry-run" ? "armed" : "off";

  selfHealMode = next;
  updateSelfHealUi();

  const enabled = selfHealMode !== "off";
  const mode = selfHealMode === "armed" ? "armed" : "dry-run";
  const msg: OpsClientMsg = { type: "setSelfHeal", enabled, mode };
  opsWs.send(JSON.stringify(msg));
  pushAiLine(`[INFO] Self-Heal: ${enabled ? mode.toUpperCase() : "OFF"}`);
});

function initSshTerminalAndUI() {
  const tabAws = document.getElementById("tabAws") as HTMLButtonElement | null;
  const tabSsh = document.getElementById("tabSsh") as HTMLButtonElement | null;
  const sshControls = document.getElementById("sshControls") as HTMLDivElement | null;
  const sshTermEl = document.getElementById("sshTerm") as HTMLDivElement | null;
  const awsTermEl = document.getElementById("awsTerm") as HTMLDivElement | null;

  const sshHost = document.getElementById("sshHost") as HTMLInputElement | null;
  const sshPort = document.getElementById("sshPort") as HTMLInputElement | null;
  const sshUser = document.getElementById("sshUser") as HTMLInputElement | null;
  const sshPass = document.getElementById("sshPass") as HTMLInputElement | null;
  const sshKey = document.getElementById("sshKey") as HTMLTextAreaElement | null;
  const btnSshConnect = document.getElementById("btnSshConnect") as HTMLButtonElement | null;
  const btnSshDisconnect = document.getElementById("btnSshDisconnect") as HTMLButtonElement | null;
  const sshState = document.getElementById("sshState") as HTMLSpanElement | null;

  if (!tabAws || !tabSsh || !sshControls || !sshTermEl || !awsTermEl) return;
  if (!sshHost || !sshPort || !sshUser || !sshPass || !sshKey || !btnSshConnect || !btnSshDisconnect || !sshState) return;
  const TerminalCtor = g("Terminal");
  if (!TerminalCtor) return;

  const tabAwsEl = tabAws;
  const tabSshEl = tabSsh;
  const sshControlsEl = sshControls;
  const sshTermDiv = sshTermEl;
  const awsTermDiv = awsTermEl;

  const sshHostEl = sshHost;
  const sshPortEl = sshPort;
  const sshUserEl = sshUser;
  const sshPassEl = sshPass;
  const sshKeyEl = sshKey;
  const btnSshConnectEl = btnSshConnect;
  const btnSshDisconnectEl = btnSshDisconnect;
  const sshStateEl = sshState;

  sshTerm = new TerminalCtor({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12,
    theme: { background: "#00000000" }
  });

  const FitAddonLib = g("FitAddon");
  const Fit = (FitAddonLib && (FitAddonLib.FitAddon || FitAddonLib)) ?? null;
  sshFit = Fit ? new Fit() : null;
  if (sshFit) sshTerm.loadAddon(sshFit);
  sshTerm.open(sshTermDiv);
  if (sshFit) sshFit.fit();
  sshTerm.writeln("SSH 터미널: 상단에서 서버 IP 입력 후 연결하세요.\r\n");

  sshTermDiv.addEventListener("mousedown", () => {
    try {
      sshTerm?.focus();
    } catch {
      // ignore
    }
  });

  type Mode = "aws" | "ssh";
  let mode: Mode = "aws";

  function setMode(next: Mode) {
    mode = next;
    if (mode === "aws") {
      tabAwsEl.classList.add("active");
      tabSshEl.classList.remove("active");
      sshControlsEl.style.display = "none";
      awsTermDiv.style.display = "block";
      sshTermDiv.style.display = "none";
      if (fitAddon) fitAddon.fit();
      try {
        awsTerm?.focus?.();
      } catch {
        // ignore
      }
    } else {
      tabSshEl.classList.add("active");
      tabAwsEl.classList.remove("active");
      sshControlsEl.style.display = "block";
      awsTermDiv.style.display = "none";
      sshTermDiv.style.display = "block";
      if (sshFit) sshFit.fit();
      try {
        sshTerm?.focus?.();
      } catch {
        // ignore
      }
    }
  }

  function setSshUiConnected(connected: boolean) {
    btnSshConnectEl.disabled = connected;
    btnSshDisconnectEl.disabled = !connected;
    sshStateEl.textContent = connected ? "상태: 연결됨" : "상태: 대기";
  }

  function connectSshWs() {
    if (sshWs && (sshWs.readyState === WebSocket.OPEN || sshWs.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    sshWs = new WebSocket(`${proto}://${location.host}/ws/ssh`);

    sshWs.addEventListener("open", () => {
      setSshUiConnected(true);
      sshTerm?.writeln("\r\n[ssh] websocket connected\r\n");
      try {
        sshTerm?.focus();
      } catch {
        // ignore
      }

      const host = sshHostEl.value.trim();
      const port = Number.parseInt(sshPortEl.value.trim() || "22", 10);
      const username = sshUserEl.value.trim();
      const password = sshPassEl.value;
      const privateKey = sshKeyEl.value;

      sshWs?.send(
        JSON.stringify({
          t: "connect",
          host,
          port: Number.isFinite(port) ? port : 22,
          username,
          password: password.length ? password : undefined,
          privateKey: privateKey.trim().length ? privateKey : undefined
        })
      );
    });

    sshWs.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as any;
        if (msg?.t === "term" && typeof msg.data === "string") {
          sshTerm?.write(msg.data);
          return;
        }
        if (msg?.t === "status") {
          const s = String(msg.status ?? "");
          sshStateEl.textContent = `상태: ${s}`;
          if (msg.level === "error") sshTerm?.writeln(`\r\n[ssh:error] ${msg.message ?? ""}\r\n`);
          return;
        }
      } catch {
        // ignore
      }
    });

    sshWs.addEventListener("close", () => {
      setSshUiConnected(false);
      sshWs = null;
      sshTerm?.writeln("\r\n[ssh] disconnected\r\n");
    });

    sshWs.addEventListener("error", () => {
      sshTerm?.writeln("\r\n[ssh] websocket error\r\n");
    });
  }

  function disconnectSshWs() {
    if (!sshWs) return;
    try {
      sshWs.send(JSON.stringify({ t: "disconnect" }));
    } catch {
      // ignore
    }
    try {
      sshWs.close();
    } catch {
      // ignore
    }
  }

  btnSshConnectEl.addEventListener("click", () => {
    const host = sshHostEl.value.trim();
    const username = sshUserEl.value.trim();
    if (!host) {
      sshStateEl.textContent = "상태: host/ip 필요";
      return;
    }
    if (!username) {
      sshStateEl.textContent = "상태: username 필요";
      return;
    }
    connectSshWs();
  });

  btnSshDisconnectEl.addEventListener("click", () => disconnectSshWs());

  sshTerm.onData((data: string) => {
    if (!sshWs || sshWs.readyState !== WebSocket.OPEN) return;
    sshWs.send(JSON.stringify({ t: "input", data }));
  });

  tabAwsEl.addEventListener("click", () => setMode("aws"));
  tabSshEl.addEventListener("click", () => setMode("ssh"));

  window.addEventListener("resize", () => {
    if (fitAddon) fitAddon.fit();
    if (sshFit) sshFit.fit();
    if (sshWs && sshWs.readyState === WebSocket.OPEN && sshTerm) {
      try {
        sshWs.send(JSON.stringify({ t: "resize", cols: sshTerm.cols, rows: sshTerm.rows }));
      } catch {
        // ignore
      }
    }
  });

  setMode("aws");
  setSshUiConnected(false);
}

if (document.readyState === "complete") {
  bootstrap();
} else {
  window.addEventListener("load", () => bootstrap(), { once: true });
}
