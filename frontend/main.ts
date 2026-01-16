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

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const el = {
  cpuVal: $("cpuVal"),
  ramVal: $("ramVal"),
  tempVal: $("tempVal"),
  netVal: $("netVal"),
  cpuBar: $("cpuBar"),
  ramBar: $("ramBar"),
  tempBar: $("tempBar"),
  netBar: $("netBar"),
  emoji: $("emoji"),
  statusText: $("statusText"),
  statusHint: $("statusHint"),
  updatedAt: $("updatedAt"),
  actionBox: $("actionBox"),
  logBox: $("logBox"),
  btnMock: $("btnMock") as HTMLButtonElement,
  btnOnce: $("btnOnce") as HTMLButtonElement
};

let demoOn = true;
let timer: number | null = null;

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

function log(msg: string) {
  const t = new Date();
  const stamp = `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")}:${t.getSeconds().toString().padStart(2, "0")}`;
  const line = `[${stamp}] ${msg}`;
  const div = document.createElement("div");
  div.textContent = line;
  el.logBox.appendChild(div);
  el.logBox.scrollTop = el.logBox.scrollHeight;
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

function render(m: Metrics) {
  el.cpuVal.textContent = String(Math.round(m.cpu));
  el.ramVal.textContent = String(Math.round(m.ram));
  el.tempVal.textContent = String(Math.round(m.temp));
  el.netVal.textContent = String(Math.round(m.net));

  setBar(el.cpuBar, m.cpu);
  setBar(el.ramBar, m.ram);
  setBar(el.tempBar, clamp(m.temp, 0, 100));
  setBar(el.netBar, clamp(m.net, 0, 500), 500);

  const v = verdictFromMetrics(m);
  el.emoji.textContent = v.emoji;
  el.statusText.textContent = v.statusText;
  el.statusHint.textContent = v.hint;
  el.updatedAt.textContent = `업데이트: ${new Date(m.updatedAt).toLocaleString()}`;

  el.actionBox.innerHTML = "";
  v.actions.forEach(a => {
    const li = document.createElement("li");
    li.textContent = a;
    el.actionBox.appendChild(li);
  });

  log(`상태=${v.statusText} ${v.emoji} | CPU ${Math.round(m.cpu)}% | RAM ${Math.round(m.ram)}% | TEMP ${Math.round(m.temp)}°C | NET ${Math.round(m.net)}ms | ERR ${m.errors}/m`);
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
    cpu, ram, temp, net, errors,
    updatedAt: nowIso()
  };
}

async function fetchMetrics(scn?: string): Promise<Metrics> {
  try {
    const url = scn ? `/api/metrics?scenario=${encodeURIComponent(scn)}` : `/api/metrics`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Metrics;
    return data;
  } catch {
    return demoMetrics(scn);
  }
}

async function updateOnce(scn?: string) {
  const m = demoOn ? demoMetrics(scn) : await fetchMetrics(scn);
  render(m);
}

function setDemoButton() {
  el.btnMock.textContent = demoOn ? "모의 데이터(데모) ON" : "모의 데이터(데모) OFF";
}

function startLoop() {
  stopLoop();
  timer = window.setInterval(() => void updateOnce(), 1100);
}

function stopLoop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

el.btnMock.addEventListener("click", () => {
  demoOn = !demoOn;
  setDemoButton();
  log(demoOn ? "데모 모드 ON" : "데모 모드 OFF (가능하면 백엔드 API 사용) ");
});

el.btnOnce.addEventListener("click", () => void updateOnce());

document.querySelectorAll<HTMLButtonElement>("button[data-scn]").forEach(btn => {
  btn.addEventListener("click", () => {
    const scn = btn.dataset.scn || "";
    log(`시나리오 실행: ${scn}`);
    void updateOnce(scn);
  });
});

setDemoButton();
log("페이지 로드됨. 기본은 데모 모드입니다.");
void updateOnce();
startLoop();
