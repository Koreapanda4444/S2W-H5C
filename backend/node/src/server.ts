import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

type Metrics = {
  cpu: number;
  ram: number;
  temp: number;
  net: number;
  errors: number;
  updatedAt: string;
};

type Verdict = {
  emoji: string;
  statusText: string;
  hint: string;
  actions: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const frontendDir = path.resolve(__dirname, "../../../frontend");
app.use(express.static(frontendDir));

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function demoMetrics(scn?: string): Metrics {
  let cpu = randomBetween(18, 55);
  let ram = randomBetween(22, 58);
  let temp = randomBetween(42, 62);
  let net = randomBetween(30, 120);
  let errors = Math.round(randomBetween(0, 5));

  if (scn === "spike") {
    cpu = randomBetween(75, 98);
    net = randomBetween(180, 420);
    errors = Math.round(randomBetween(8, 35));
  }
  if (scn === "overheat") {
    temp = randomBetween(78, 92);
    cpu = randomBetween(60, 90);
    errors = Math.round(randomBetween(6, 28));
  }
  if (scn === "leak") {
    ram = randomBetween(82, 99);
    cpu = randomBetween(45, 80);
    errors = Math.round(randomBetween(4, 18));
  }
  if (scn === "down") {
    cpu = randomBetween(0, 5);
    ram = randomBetween(0, 8);
    temp = randomBetween(20, 35);
    net = randomBetween(999, 1400);
    errors = Math.round(randomBetween(60, 120));
  }

  return {
    cpu: clamp(cpu, 0, 100),
    ram: clamp(ram, 0, 100),
    temp,
    net,
    errors,
    updatedAt: new Date().toISOString()
  };
}

function verdictFromMetrics(m: Metrics): Verdict {
  const hot = m.temp >= 80;
  const warm = m.temp >= 75;
  const heavy = m.cpu >= 85 || m.ram >= 85;
  const lag = m.net >= 250;
  const err = m.errors >= 25;

  if (hot || (lag && err && heavy)) {
    return {
      emoji: "😡",
      statusText: "위험",
      hint: "즉시 안정화 조치가 필요합니다.",
      actions: [
        "냉각 강화(팬/냉각수) + 핫노드 격리",
        "부하 분산(로드밸런싱/오토스케일)",
        "레이트리밋 적용(폭주 트래픽 제한)",
        "문제 서비스 안전 재시작(컨테이너/프로세스)"
      ]
    };
  }

  if (warm || heavy || m.net >= 180 || m.errors >= 12) {
    return {
      emoji: "🤨",
      statusText: "주의",
      hint: "확산 전에 선제 대응을 권장합니다.",
      actions: [
        "부하 분산 검토(트래픽 분산/스케일아웃)",
        "메모리/핸들 누수 의심 서비스 점검",
        "디스크/네트워크 병목 모니터링 강화"
      ]
    };
  }

  if (m.cpu <= 35 && m.ram <= 35 && m.temp <= 55 && m.net <= 80 && m.errors <= 2) {
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

function pythonAnalyze(m: Metrics): Verdict | null {
  const pyPath = path.resolve(__dirname, "../../python/analyzer.py");
  try {
    const child = spawnSync("python3", [pyPath], {
      input: JSON.stringify(m),
      encoding: "utf-8"
    });
    if (child.status !== 0) return null;
    const out = JSON.parse(child.stdout);
    return out as Verdict;
  } catch {
    return null;
  }
}

app.get("/api/metrics", (req, res) => {
  const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
  res.json(demoMetrics(scenario));
});

app.post("/api/emoji", (req, res) => {
  const m = req.body as Metrics;
  const fromPy = pythonAnalyze(m);
  res.json(fromPy ?? verdictFromMetrics(m));
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;
app.listen(PORT, () => {
  console.log(`[DC] server listening on http://localhost:${PORT}`);
  console.log(`[DC] serving frontend from ${frontendDir}`);
});
