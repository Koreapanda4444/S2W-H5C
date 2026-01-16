import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer } from "ws";
import { Client as SshClient } from "ssh2";
import os from "os";
import { spawn } from "child_process";
import fs from "fs";
import { AnomalyDetector, SelfHealing, type AiEvent, type MetricsSample } from "./aiops.js";

type Metrics = {
  cpu: number;
  ram: number;
  disk: number;
  io: number;
  errors: number;
  updatedAt: string;
  source?: "demo" | "ssh" | "local" | "monitor";
};

type OpsWsMsg =
  | { type: "status"; level: "info" | "error"; message: string }
  | { type: "metrics"; metrics: Metrics }
  | { type: "ai"; event: AiEvent }
  | { type: "selfheal"; enabled: boolean; mode: "dry-run" | "armed"; rateLimited: boolean; isolated: boolean };


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = http.createServer(app);

const frontendDir = path.resolve(__dirname, "../../../frontend");
app.use(express.static(frontendDir));

const selfHeal = new SelfHealing({
  enabled: process.env.SELF_HEAL_ENABLED === "1",
  mode: process.env.SELF_HEAL_MODE === "armed" ? "armed" : "dry-run",
  rateLimitSeconds: process.env.SELF_HEAL_RATE_LIMIT_SECONDS ? Number(process.env.SELF_HEAL_RATE_LIMIT_SECONDS) : 30
});

app.use((req, res, next) => {
  if (!selfHeal.isRateLimited()) return next();
  const pathOk = req.path.startsWith("/api/") || req.path.startsWith("/ws/") || req.path.startsWith("/vendor/") || req.path.startsWith("/dist/") || req.path === "/";
  if (!pathOk) return next();
  res.status(429).send("rate limited");
});

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function demoMetrics(scn?: string): Metrics {
  let cpu = randomBetween(18, 55);
  let ram = randomBetween(22, 58);
  let disk = randomBetween(35, 75);
  let io = randomBetween(5, 35);
  let errors = Math.round(randomBetween(0, 5));

  if (scn === "spike") {
    cpu = randomBetween(75, 98);
    errors = Math.round(randomBetween(8, 35));
  }
  if (scn === "overheat") {
    cpu = randomBetween(60, 90);
    errors = Math.round(randomBetween(6, 28));
  }
  if (scn === "leak") {
    ram = randomBetween(82, 99);
    cpu = randomBetween(45, 80);
    io = randomBetween(30, 75);
    errors = Math.round(randomBetween(4, 18));
  }
  if (scn === "down") {
    cpu = randomBetween(0, 5);
    ram = randomBetween(0, 8);
    io = randomBetween(0, 5);
    errors = Math.round(randomBetween(60, 120));
  }

  return {
    cpu: clamp(cpu, 0, 100),
    ram: clamp(ram, 0, 100),
    disk: clamp(disk, 0, 100),
    io: clamp(io, 0, 100),
    errors,
    updatedAt: new Date().toISOString(),
    source: "demo"
  };
}

type CpuSample = { idle: number; total: number };
let lastCpuSample: CpuSample | null = null;

function readCpuSample(): CpuSample {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

async function getWindowsDiskIoPercent(): Promise<number> {
  return await new Promise((resolve) => {
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-Counter '\\PhysicalDisk(_Total)\\% Disk Time').CounterSamples[0].Cooked"
      ],
      { windowsHide: true }
    );

    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString("utf-8")));
    ps.on("error", () => resolve(0));
    ps.on("close", () => {
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) ? clamp(n, 0, 100) : 0);
    });
  });
}

async function getWindowsDiskUsagePercent(drive: string): Promise<number> {
  return await new Promise((resolve) => {
    const letter = drive.endsWith(":") ? drive : `${drive}:`;
    const cmd =
      "$d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='" +
      letter.replace(/'/g, "''") +
      "'\"; " +
      "if ($d -and $d.Size -gt 0) { [math]::Round((($d.Size-$d.FreeSpace)/$d.Size)*100,2) } else { 0 }";

    const ps = spawn("powershell", ["-NoProfile", "-Command", cmd], { windowsHide: true });
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString("utf-8")));
    ps.on("error", () => resolve(0));
    ps.on("close", () => {
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) ? clamp(n, 0, 100) : 0);
    });
  });
}

async function getLocalMetrics(): Promise<Metrics> {
  const now = new Date().toISOString();

  const cur = readCpuSample();
  let cpuPct = 0;
  if (lastCpuSample) {
    const idleDelta = cur.idle - lastCpuSample.idle;
    const totalDelta = cur.total - lastCpuSample.total;
    if (totalDelta > 0) cpuPct = (1 - idleDelta / totalDelta) * 100;
  }
  lastCpuSample = cur;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMemPct = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;

  let ioPct = 0;
  let diskPct = 0;
  if (process.platform === "win32") {
    [ioPct, diskPct] = await Promise.all([getWindowsDiskIoPercent(), getWindowsDiskUsagePercent("C:")]);
  }

  return {
    cpu: clamp(cpuPct, 0, 100),
    ram: clamp(usedMemPct, 0, 100),
    disk: clamp(diskPct, 0, 100),
    io: clamp(ioPct, 0, 100),
    errors: 0,
    updatedAt: now,
    source: "local"
  };
}

function isValidHttpUrl(s: string) {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

async function getMonitorMetrics(url: string): Promise<Metrics> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;

    const cpu = clamp(safeNumber(data?.cpu_percent, 0), 0, 100);
    const ram = clamp(safeNumber(data?.memory_percent, 0), 0, 100);
    const disk = clamp(safeNumber(data?.disk_percent, 0), 0, 100);
    // IO가 없어서 응답 지연을 %로 환산(1000ms -> 100)
    const io = clamp(latencyMs / 10, 0, 100);

    return {
      cpu,
      ram,
      disk,
      io,
      errors: 0,
      updatedAt: new Date().toISOString(),
      source: "monitor"
    };
  } finally {
    clearTimeout(timeout);
  }
}


app.get("/api/metrics", (req, res) => {
  const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
  if (scenario) {
    res.json(demoMetrics(scenario));
    return;
  }
  void getLocalMetrics()
    .then((m) => res.json(m))
    .catch(() => res.json(demoMetrics()));
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

type WsConnectMsg = {
  t: "connect";
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  cols?: number;
  rows?: number;
};

type WsClientMsg =
  | WsConnectMsg
  | { t: "input"; data: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "disconnect" };

type WsServerMsg =
  | { t: "status"; status: string; level?: "info" | "error"; message?: string }
  | { t: "term"; data: string };

function isValidHost(host: string) {
  if (!host) return false;
  if (host.length > 255) return false;
  // very small sanity check: no spaces/control chars
  if (/\s/.test(host)) return false;
  return true;
}

function safeNumber(n: unknown, fallback: number) {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? x : fallback;
}

const wss = new WebSocketServer({ noServer: true });

const wssOps = new WebSocketServer({ noServer: true });
const wssAws = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/ws/ssh") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    if (url.pathname === "/ws/ops") {
      wssOps.handleUpgrade(req, socket, head, (ws) => wssOps.emit("connection", ws, req));
      return;
    }
    if (url.pathname === "/ws/aws") {
      wssAws.handleUpgrade(req, socket, head, (ws) => wssAws.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  } catch {
    socket.destroy();
  }
});

wssOps.on("connection", (ws) => {
  let timer: NodeJS.Timeout | null = null;
  let source: "local" | "monitor" = "local";
  let monitorUrl = process.env.EC2_MONITOR_URL ?? "";
  let errorStreak = 0;

  const detector = new AnomalyDetector();

  function send(msg: OpsWsMsg) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  send({ type: "status", level: "info", message: "OPS stream connected" });
  send({
    type: "selfheal",
    enabled: selfHeal.getConfig().enabled,
    mode: selfHeal.getConfig().mode,
    rateLimited: selfHeal.isRateLimited(),
    isolated: selfHeal.isIsolated()
  });

  async function tick() {
    try {
      if (selfHeal.isIsolated()) {
        send({ type: "status", level: "error", message: "노드 격리 상태: 모니터링 중지" });
        return;
      }

      if (source === "monitor") {
        if (!monitorUrl || !isValidHttpUrl(monitorUrl)) {
          send({ type: "status", level: "error", message: "EC2 /monitor URL이 올바르지 않습니다." });
          source = "local";
          errorStreak = 0;
          return;
        }
        const m = await getMonitorMetrics(monitorUrl);
        errorStreak = 0;
        send({ type: "metrics", metrics: m });

        detector.push(m as unknown as MetricsSample);
        const events = detector.detect(m.source ?? "monitor");
        const applied = selfHeal.apply(events);
        for (const ev of applied) send({ type: "ai", event: ev });
        if (events.length > 0) {
          send({
            type: "selfheal",
            enabled: selfHeal.getConfig().enabled,
            mode: selfHeal.getConfig().mode,
            rateLimited: selfHeal.isRateLimited(),
            isolated: selfHeal.isIsolated()
          });
        }
        return;
      }

      const m = await getLocalMetrics();
      errorStreak = 0;
      send({ type: "metrics", metrics: m });

      detector.push(m as unknown as MetricsSample);
      const events = detector.detect(m.source ?? "local");
      const applied = selfHeal.apply(events);
      for (const ev of applied) send({ type: "ai", event: ev });
      if (events.length > 0) {
        send({
          type: "selfheal",
          enabled: selfHeal.getConfig().enabled,
          mode: selfHeal.getConfig().mode,
          rateLimited: selfHeal.isRateLimited(),
          isolated: selfHeal.isIsolated()
        });
      }
    } catch (e) {
      errorStreak++;
      send({ type: "status", level: "error", message: `OPS 수집 실패(${errorStreak}): ${String((e as any)?.message ?? e)}` });
      if (source === "monitor" && errorStreak >= 3) {
        send({ type: "status", level: "error", message: "EC2 응답 실패로 LOCAL로 전환" });
        source = "local";
        errorStreak = 0;

        const ev: AiEvent = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          at: new Date().toISOString(),
          type: "agent_unreachable",
          severity: "warn",
          message: "EC2 /monitor 응답 실패(연속)로 LOCAL 전환",
          source: "monitor"
        };
        send({ type: "ai", event: ev });
      }
    }
  }

  timer = setInterval(() => {
    void tick();
  }, 1200);

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send({ type: "status", level: "error", message: "OPS: JSON 파싱 실패" });
      return;
    }

    if (msg?.type === "setSource" && msg?.source === "local") {
      source = "local";
      errorStreak = 0;
      send({ type: "status", level: "info", message: "LOCAL" });
      return;
    }

    if (msg?.type === "setSource" && msg?.source === "monitor") {
      const url = String(msg?.url ?? "").trim();
      if (!isValidHttpUrl(url)) {
        send({ type: "status", level: "error", message: "EC2 /monitor URL 형식이 올바르지 않습니다." });
        return;
      }
      monitorUrl = url;
      source = "monitor";
      errorStreak = 0;
      send({ type: "status", level: "info", message: "EC2 /monitor" });
      void tick();
      return;
    }

    if (msg?.type === "setSelfHeal") {
      const enabled = Boolean(msg?.enabled);
      const mode = msg?.mode === "armed" ? "armed" : "dry-run";
      const rateLimitSeconds = typeof msg?.rateLimitSeconds === "number" ? msg.rateLimitSeconds : undefined;
      selfHeal.setConfig({ enabled, mode, rateLimitSeconds });
      send({
        type: "selfheal",
        enabled: selfHeal.getConfig().enabled,
        mode: selfHeal.getConfig().mode,
        rateLimited: selfHeal.isRateLimited(),
        isolated: selfHeal.isIsolated()
      });
      return;
    }
  });

  ws.on("close", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
});

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        cur += line[i + 1];
        i++;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as any;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

wssAws.on("connection", (ws) => {
  function send(msg: { type: "status"; level: "info" | "error"; message: string } | { type: "term"; data: string }) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  let cwd = process.cwd();
  send({ type: "status", level: "info", message: "SHELL connected" });
  send({ type: "term", data: `cwd: ${cwd}\r\n` });

  function normalizeCwd(next: string) {
    const base = path.resolve(cwd);
    const target = path.resolve(base, next);
    return target;
  }

  function spawnWindowsShell(command: string, args: string[], onDone?: (code: number) => void) {
    const child = spawn(command, args, { windowsHide: true, cwd });
    child.stdout.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
    child.stderr.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
    child.on("error", (err) => send({ type: "status", level: "error", message: `실행 실패: ${String(err)}` }));
    child.on("close", (code) => onDone?.(code ?? 0));
  }

  ws.on("message", (raw) => {
    let msg: { type: "run"; line: string } | null = null;
    try {
      msg = JSON.parse(String(raw)) as { type: "run"; line: string };
    } catch {
      send({ type: "status", level: "error", message: "JSON 파싱 실패" });
      return;
    }

    if (msg.type !== "run") return;
    const line = (msg.line ?? "").trim();
    if (!line) {
      send({ type: "term", data: "\r\n" });
      return;
    }

    if (line.length > 2000) {
      send({ type: "status", level: "error", message: "명령이 너무 깁니다." });
      return;
    }

    const parts = tokenize(line);
    const cmd = (parts[0] ?? "").toLowerCase();
    const args = parts.slice(1);

    if (cmd === "help") {
      send({
        type: "term",
        data: "allowed: ls, dir, pwd, cd <path>, whoami, echo <...>, cat/type <file>, aws <...>\r\n"
      });
      return;
    }

    if (cmd === "pwd") {
      send({ type: "term", data: `${cwd}\r\n` });
      return;
    }

    if (cmd === "cd") {
      const next = args.join(" ").trim();
      if (!next) {
        send({ type: "term", data: `${cwd}\r\n` });
        return;
      }
      const target = normalizeCwd(next);
      try {
        const st = fs.statSync(target);
        if (!st.isDirectory()) {
          send({ type: "status", level: "error", message: "cd: not a directory" });
          return;
        }
        cwd = target;
        send({ type: "term", data: `cwd: ${cwd}\r\n` });
      } catch {
        send({ type: "status", level: "error", message: "cd: path not found" });
      }
      return;
    }

    if (cmd === "ls" || cmd === "dir") {
      if (process.platform === "win32") {
        const ps = "Get-ChildItem -Force | Format-Table -AutoSize | Out-String -Width 4096";
        spawnWindowsShell("powershell", ["-NoProfile", "-Command", ps], (code) => {
          send({ type: "term", data: `\r\n(exit ${code})\r\n` });
        });
        return;
      }
      const child = spawn("ls", ["-la"], { cwd });
      child.stdout.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.stderr.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.on("close", (code) => send({ type: "term", data: `\r\n(exit ${code ?? 0})\r\n` }));
      return;
    }

    if (cmd === "whoami") {
      if (process.platform === "win32") {
        spawnWindowsShell("whoami", [], (code) => send({ type: "term", data: `\r\n(exit ${code})\r\n` }));
        return;
      }
      const child = spawn("whoami", [], { cwd });
      child.stdout.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.stderr.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.on("close", (code) => send({ type: "term", data: `\r\n(exit ${code ?? 0})\r\n` }));
      return;
    }

    if (cmd === "echo") {
      send({ type: "term", data: `${args.join(" ")}\r\n` });
      return;
    }

    if (cmd === "cat" || cmd === "type") {
      const file = args.join(" ").trim();
      if (!file) {
        send({ type: "status", level: "error", message: "cat/type: file required" });
        return;
      }
      if (process.platform === "win32") {
        const target = normalizeCwd(file);
        const ps =
          "Get-Content -LiteralPath '" +
          target.replace(/'/g, "''") +
          "' -ErrorAction Stop | Select-Object -First 200 | Out-String -Width 4096";
        spawnWindowsShell("powershell", ["-NoProfile", "-Command", ps], (code) => {
          send({ type: "term", data: `\r\n(exit ${code})\r\n` });
        });
        return;
      }
      const child = spawn("cat", [file], { cwd });
      child.stdout.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.stderr.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.on("close", (code) => send({ type: "term", data: `\r\n(exit ${code ?? 0})\r\n` }));
      return;
    }

    if (cmd === "aws") {
      const child = spawn("aws", args, { windowsHide: true, cwd });
      child.stdout.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.stderr.on("data", (d) => send({ type: "term", data: d.toString("utf-8").replace(/\n/g, "\r\n") }));
      child.on("error", (err) => send({ type: "status", level: "error", message: `aws 실행 실패: ${String(err)}` }));
      child.on("close", (code) => send({ type: "term", data: `\r\n(exit ${code ?? 0})\r\n` }));
      return;
    }

    send({ type: "status", level: "error", message: "허용되지 않은 명령입니다. help 를 입력하세요." });
  });
});

wss.on("connection", (ws) => {
  let ssh: SshClient | null = null;
  let shell: any | null = null;

  function send(msg: WsServerMsg) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  function cleanup(reason?: string) {
    try {
      shell?.end?.();
    } catch {
      // ignore
    }
    shell = null;
    try {
      ssh?.end();
    } catch {
      // ignore
    }
    ssh = null;
    if (reason) send({ t: "status", status: reason, level: "info", message: reason });
  }

  ws.on("message", (raw) => {
    let msg: any | null = null;
    try {
      msg = JSON.parse(String(raw)) as any;
    } catch {
      send({ t: "status", status: "parse-error", level: "error", message: "메시지 JSON 파싱 실패" });
      return;
    }

    const t: string | undefined = msg?.t ?? msg?.type;

    if (t === "connect") {
      cleanup();

      const host = msg.host?.trim();
      const port = clamp(safeNumber(msg.port, 22), 1, 65535);
      const username = msg.username?.trim();

      if (!isValidHost(host) || !username) {
        send({ t: "status", status: "invalid", level: "error", message: "host/username 값이 올바르지 않습니다." });
        return;
      }

      const rawPrivateKey: string | undefined = msg.privateKey?.trim() || undefined;
      const privateKey: string | undefined = rawPrivateKey
        ? rawPrivateKey.replace(/\r\n/g, "\n").trim() + "\n"
        : undefined;

      const password: string | undefined = typeof msg.password === "string" && msg.password.length ? msg.password : undefined;
      const passphrase: string | undefined = typeof msg.passphrase === "string" && msg.passphrase.length ? msg.passphrase : undefined;

      send({ t: "status", status: "connecting", level: "info", message: `SSH 연결 시도: ${username}@${host}:${port}` });
      ssh = new SshClient();

      ssh
        .on("ready", () => {
          send({ t: "status", status: "connected", level: "info", message: "SSH 연결됨" });

          const cols = clamp(safeNumber(msg.cols, 120), 20, 300);
          const rows = clamp(safeNumber(msg.rows, 30), 10, 120);

          ssh?.shell(
            {
              term: "xterm-256color",
              cols,
              rows
            },
            (err, stream) => {
              if (err) {
                send({ t: "status", status: "shell-error", level: "error", message: `shell 생성 실패: ${String(err)}` });
                cleanup();
                return;
              }
              shell = stream;
              stream.on("data", (d: Buffer) => send({ t: "term", data: d.toString("utf-8") }));
              stream.stderr?.on?.("data", (d: Buffer) => send({ t: "term", data: d.toString("utf-8") }));
              stream.on("close", () => cleanup("SSH shell 종료"));
            }
          );
        })
        .on("error", (err: any) => {
          const extra = [err?.level, err?.code].filter(Boolean).join("/");
          const extraStr = extra ? ` (${extra})` : "";
          send({ t: "status", status: "ssh-error", level: "error", message: `SSH 오류${extraStr}: ${String(err?.message ?? err)}` });
          cleanup();
        })
        .on("close", () => {
          cleanup("SSH 연결 종료");
        });

      try {
        ssh.connect({
          host,
          port,
          username,
          password,
          privateKey,
          passphrase,
          readyTimeout: 15_000,
          keepaliveInterval: 10_000
        });
      } catch (e: any) {
        send({ t: "status", status: "ssh-error", level: "error", message: `SSH connect 실패: ${String(e?.message ?? e)}` });
        cleanup();
      }

      return;
    }

    if (t === "input") {
      if (shell) shell.write(msg.data);
      return;
    }

    if (t === "resize") {
      try {
        shell?.setWindow?.(msg.rows, msg.cols, 0, 0);
      } catch {
        // ignore
      }
      return;
    }

    if (t === "disconnect") {
      cleanup("연결 해제됨");
    }
  });

  ws.on("close", () => cleanup());
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;
server.listen(PORT, () => {
  console.log(`[H5C] server listening on http://localhost:${PORT}`);
  console.log(`[H5C] serving frontend from ${frontendDir}`);
});
