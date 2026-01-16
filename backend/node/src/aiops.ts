export type MetricsSample = {
  cpu: number;
  ram: number;
  disk: number;
  io: number;
  errors: number;
  updatedAt: string;
  source?: string;
};

export type AiSeverity = "info" | "warn" | "critical";

export type AiEventType =
  | "cpu_spike"
  | "ram_spike"
  | "ram_leak"
  | "disk_full"
  | "io_spike"
  | "agent_unreachable"
  | "rate_limit_enabled"
  | "node_isolated"
  | "selfheal_noop";

export type AiAction =
  | { kind: "enable_rate_limit"; reason: string; seconds: number }
  | { kind: "isolate_node"; reason: string }
  | { kind: "restart_service"; reason: string; service: string }
  | { kind: "restart_container"; reason: string; container: string }
  | { kind: "load_balance_hint"; reason: string };

export type AiEvent = {
  id: string;
  at: string;
  type: AiEventType;
  severity: AiSeverity;
  message: string;
  source: string;
  metrics?: MetricsSample;
  actions?: AiAction[];
  executed?: { mode: "dry-run" | "armed"; actions: AiAction[] };
};

export type SelfHealConfig = {
  enabled: boolean;
  mode: "dry-run" | "armed";
  rateLimitSeconds: number;
};

type Stats = { mean: number; std: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function meanStd(values: number[]): Stats {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let v = 0;
  for (const x of values) v += (x - mean) * (x - mean);
  v /= values.length;
  return { mean, std: Math.sqrt(v) };
}

function isoNow() {
  return new Date().toISOString();
}

function idNow() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AnomalyDetector {
  private window: MetricsSample[] = [];
  private readonly max = 120;
  private lastLeakAtMs = 0;
  private lastSpikeAtMs: Partial<Record<AiEventType, number>> = {};

  push(m: MetricsSample) {
    this.window.push(m);
    while (this.window.length > this.max) this.window.shift();
  }

  detect(source: string): AiEvent[] {
    if (this.window.length < 1) return [];

    const last = this.window[this.window.length - 1];
    const recent = this.window.slice(-60);
    const baseline = recent.length >= 2 ? recent.slice(0, -1) : recent;

    const now = Date.now();
    const cooldown = (t: AiEventType, ms: number) => now - (this.lastSpikeAtMs[t] ?? 0) < ms;
    const mark = (t: AiEventType) => {
      this.lastSpikeAtMs[t] = now;
    };

    const out: AiEvent[] = [];

    // 초기 구간에도 바로 동작하는 절대 임계치 기반 감지
    if (last.cpu >= 95 && !cooldown("cpu_spike", 15_000)) {
      mark("cpu_spike");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "cpu_spike",
        severity: "critical",
        message: `CPU 임계치 감지: ${Math.round(last.cpu)}%`,
        source,
        metrics: last,
        actions: [
          { kind: "enable_rate_limit", reason: "cpu_spike", seconds: 30 },
          { kind: "load_balance_hint", reason: "트래픽 분산/스케일아웃 검토" }
        ]
      });
    }

    if (last.ram >= 95 && !cooldown("ram_spike", 15_000)) {
      mark("ram_spike");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "ram_spike",
        severity: "critical",
        message: `RAM 임계치 감지: ${Math.round(last.ram)}%`,
        source,
        metrics: last,
        actions: [
          { kind: "enable_rate_limit", reason: "ram_spike", seconds: 30 },
          { kind: "load_balance_hint", reason: "메모리 누수/프로세스 점검" }
        ]
      });
    }

    if (last.io >= 95 && !cooldown("io_spike", 12_000)) {
      mark("io_spike");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "io_spike",
        severity: "critical",
        message: `I/O 임계치 감지: ${Math.round(last.io)}%`,
        source,
        metrics: last,
        actions: [{ kind: "enable_rate_limit", reason: "io_spike", seconds: 20 }]
      });
    }

    if (last.disk >= 90 && !cooldown("disk_full", 30_000)) {
      mark("disk_full");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "disk_full",
        severity: last.disk >= 97 ? "critical" : "warn",
        message: `DISK 임계치: ${Math.round(last.disk)}%`,
        source,
        metrics: last,
        actions: [{ kind: "load_balance_hint", reason: "로그/캐시 정리 또는 볼륨 증설" }]
      });
    }

    // 통계 기반 감지는 최소 샘플이 쌓인 후 수행
    if (this.window.length < 8) return out;

    const cpuS = meanStd(baseline.map((x) => x.cpu));
    const ramS = meanStd(baseline.map((x) => x.ram));
    const ioS = meanStd(baseline.map((x) => x.io));

    const z = (x: number, s: Stats) => {
      if (s.std > 0.001) return (x - s.mean) / s.std;
      // 분산이 거의 없는데 값이 크게 튀면 스파이크로 취급
      return x >= s.mean + 5 ? 999 : 0;
    };

    const cpuZ = z(last.cpu, cpuS);
    if (last.cpu < 95 && last.cpu >= 85 && cpuZ >= 2.8 && !cooldown("cpu_spike", 15_000)) {
      mark("cpu_spike");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "cpu_spike",
        severity: last.cpu >= 95 ? "critical" : "warn",
        message: `CPU 급등 감지: ${Math.round(last.cpu)}% (z=${cpuZ.toFixed(1)})`,
        source,
        metrics: last,
        actions: [
          { kind: "enable_rate_limit", reason: "cpu_spike", seconds: 30 },
          { kind: "load_balance_hint", reason: "트래픽 분산/스케일아웃 검토" }
        ]
      });
    }

    const ramZ = z(last.ram, ramS);
    if (last.ram < 95 && last.ram >= 85 && ramZ >= 2.8 && !cooldown("ram_spike", 15_000)) {
      mark("ram_spike");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "ram_spike",
        severity: last.ram >= 95 ? "critical" : "warn",
        message: `RAM 급등 감지: ${Math.round(last.ram)}% (z=${ramZ.toFixed(1)})`,
        source,
        metrics: last,
        actions: [
          { kind: "enable_rate_limit", reason: "ram_spike", seconds: 30 },
          { kind: "load_balance_hint", reason: "메모리 누수/프로세스 점검" }
        ]
      });
    }

    const ioZ = z(last.io, ioS);
    if (last.io < 95 && last.io >= 85 && ioZ >= 2.6 && !cooldown("io_spike", 12_000)) {
      mark("io_spike");
      out.push({
        id: idNow(),
        at: isoNow(),
        type: "io_spike",
        severity: last.io >= 95 ? "critical" : "warn",
        message: `I/O 이상 감지: ${Math.round(last.io)}% (z=${ioZ.toFixed(1)})`,
        source,
        metrics: last,
        actions: [{ kind: "enable_rate_limit", reason: "io_spike", seconds: 20 }]
      });
    }

    const leak = this.detectRamLeak();
    if (leak) out.push(leak);

    return out;
  }

  private detectRamLeak(): AiEvent | null {
    const now = Date.now();
    if (now - this.lastLeakAtMs < 20_000) return null;
    const series = this.window.slice(-25);
    if (series.length < 25) return null;

    const ys = series.map((x) => x.ram);
    const xs = ys.map((_, i) => i);
    const n = ys.length;

    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) * (xs[i] - xMean);
    }

    const slope = den > 0 ? num / den : 0;
    const rise = ys[ys.length - 1] - ys[0];

    if (ys[ys.length - 1] >= 80 && rise >= 8 && slope >= 0.22) {
      this.lastLeakAtMs = now;
      const last = series[series.length - 1];
      return {
        id: idNow(),
        at: isoNow(),
        type: "ram_leak",
        severity: ys[ys.length - 1] >= 92 ? "critical" : "warn",
        message: `메모리 누수 의심: +${rise.toFixed(1)}%/약 ${n}샘플`,
        source: String(last.source ?? "unknown"),
        metrics: last,
        actions: [
          { kind: "enable_rate_limit", reason: "ram_leak", seconds: 45 },
          { kind: "load_balance_hint", reason: "프로세스 재시작/배포 롤백 검토" }
        ]
      };
    }

    return null;
  }
}

export class SelfHealing {
  private cfg: SelfHealConfig;
  private rateLimitUntilMs = 0;
  private isolated = false;

  constructor(cfg?: Partial<SelfHealConfig>) {
    this.cfg = {
      enabled: cfg?.enabled ?? false,
      mode: cfg?.mode ?? "dry-run",
      rateLimitSeconds: cfg?.rateLimitSeconds ?? 30
    };
  }

  getConfig(): SelfHealConfig {
    return { ...this.cfg };
  }

  setConfig(next: Partial<SelfHealConfig>) {
    if (typeof next.enabled === "boolean") this.cfg.enabled = next.enabled;
    if (next.mode === "dry-run" || next.mode === "armed") this.cfg.mode = next.mode;
    if (typeof next.rateLimitSeconds === "number" && Number.isFinite(next.rateLimitSeconds)) {
      this.cfg.rateLimitSeconds = clamp(next.rateLimitSeconds, 5, 300);
    }
  }

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitUntilMs;
  }

  isIsolated(): boolean {
    return this.isolated;
  }

  apply(events: AiEvent[]): AiEvent[] {
    if (!this.cfg.enabled) return events;

    const enriched: AiEvent[] = [];
    for (const ev of events) {
      const actions = ev.actions ?? [];
      if (actions.length === 0) {
        enriched.push(ev);
        continue;
      }

      const executed: AiAction[] = [];

      for (const a of actions) {
        if (this.cfg.mode === "dry-run") {
          executed.push(a);
          continue;
        }

        if (a.kind === "enable_rate_limit") {
          const sec = clamp(a.seconds ?? this.cfg.rateLimitSeconds, 5, 300);
          this.rateLimitUntilMs = Math.max(this.rateLimitUntilMs, Date.now() + sec * 1000);
          executed.push(a);
          continue;
        }

        if (a.kind === "isolate_node") {
          this.isolated = true;
          executed.push(a);
          continue;
        }

        executed.push({ kind: "load_balance_hint", reason: "실행 불가(설명용)" });
      }

      enriched.push({
        ...ev,
        executed: { mode: this.cfg.mode, actions: executed }
      });
    }

    return enriched;
  }
}
