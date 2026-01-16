import argparse
from collections import deque
import json
import os
import platform
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

import requests

try:
    import psutil
except Exception:
    psutil = None

DEFAULT_REMOTE_IP = "3.36.74.135"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 5000
DEFAULT_PATH = "/monitor"
DEFAULT_POLL_SECONDS = 2

_log_cv = threading.Condition()
_log_seq = 0
_log_buf = deque(maxlen=800)

_last_metrics_log_ts: float = 0.0
_prev_io_read: Optional[int] = None
_prev_io_write: Optional[int] = None
_prev_io_ts: Optional[float] = None


def _log(line: str) -> None:
    global _log_seq
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    full = f"{stamp} {line}"
    try:
        print(full, flush=True)
    except Exception:
        pass
    with _log_cv:
        _log_seq += 1
        _log_buf.append((_log_seq, full))
        _log_cv.notify_all()


def _maybe_log_metrics(metrics: dict) -> None:
    global _last_metrics_log_ts, _prev_io_read, _prev_io_write, _prev_io_ts
    now = time.time()
    if now - _last_metrics_log_ts < 1.5:
        return
    _last_metrics_log_ts = now

    cpu = metrics.get("cpu_percent")
    ram = metrics.get("memory_percent")
    disk = metrics.get("disk_percent")

    r = metrics.get("io_read_bytes")
    w = metrics.get("io_write_bytes")

    read_mbps = None
    write_mbps = None
    if isinstance(r, int) and isinstance(w, int):
        if _prev_io_read is not None and _prev_io_write is not None and _prev_io_ts is not None:
            dt = max(0.001, now - _prev_io_ts)
            read_mbps = ((r - _prev_io_read) / 1024 / 1024) / dt
            write_mbps = ((w - _prev_io_write) / 1024 / 1024) / dt
        _prev_io_read = r
        _prev_io_write = w
        _prev_io_ts = now

    if read_mbps is not None and write_mbps is not None:
        _log(f"monitor cpu={cpu}% ram={ram}% disk={disk}% ioR={read_mbps:.2f}MB/s ioW={write_mbps:.2f}MB/s")
    else:
        _log(f"monitor cpu={cpu}% ram={ram}% disk={disk}%")


def clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def _read_proc_stat_cpu() -> Optional[Tuple[int, int]]:
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            line = f.readline().strip()
        if not line.startswith("cpu "):
            return None
        parts = line.split()
        values = [int(x) for x in parts[1:]]
        total = sum(values)
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return total, idle
    except Exception:
        return None


def cpu_percent_sample(sample_sec: float = 0.1) -> Optional[float]:
    a = _read_proc_stat_cpu()
    if a is None:
        return None
    time.sleep(sample_sec)
    b = _read_proc_stat_cpu()
    if b is None:
        return None
    total_a, idle_a = a
    total_b, idle_b = b
    dt = total_b - total_a
    didle = idle_b - idle_a
    if dt <= 0:
        return None
    usage = (dt - didle) / dt * 100.0
    return clamp(usage, 0.0, 100.0)


def memory_percent_linux() -> Tuple[Optional[float], Optional[float]]:
    try:
        mem_total = None
        mem_avail = None
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1]) * 1024
                elif line.startswith("MemAvailable:"):
                    mem_avail = int(line.split()[1]) * 1024
                if mem_total is not None and mem_avail is not None:
                    break
        if mem_total is None or mem_avail is None or mem_total <= 0:
            return None, None
        used = mem_total - mem_avail
        percent = used / mem_total * 100.0
        free_gb = mem_avail / (1024**3)
        return clamp(percent, 0.0, 100.0), round(free_gb, 2)
    except Exception:
        return None, None


_prev_diskstats: Optional[Dict[str, Tuple[int, int]]] = None
_prev_diskstats_ts: Optional[float] = None


def _read_diskstats() -> Optional[Dict[str, Tuple[int, int]]]:
    """Linux /proc/diskstats 파싱 - 파티션 제외하고 실제 디스크만 집계"""
    try:
        result: Dict[str, Tuple[int, int]] = {}
        with open("/proc/diskstats", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 14:
                    continue
                dev = parts[2]

                # 1. 램디스크, 루프백 제외
                if dev.startswith(("loop", "ram")):
                    continue
                
                # 2. 파티션 걸러내기 (sda1, xvda1 등은 제외하고 sda, xvda만 포함)
                #    nvme0n1(디스크) vs nvme0n1p1(파티션)
                is_partition = False
                
                if dev.startswith("nvme"):
                    if "p" in dev: 
                        is_partition = True
                elif dev.startswith(("sd", "vd", "xvd")):
                    # 끝자리가 숫자면 파티션일 확률 높음 (sda1, xvda1)
                    # 하지만 sda 처럼 숫자가 없으면 디스크
                    if dev[-1].isdigit():
                        is_partition = True
                else:
                    # 그 외 알 수 없는 디바이스는 일단 패스
                    continue

                if is_partition:
                    continue

                read_sectors = int(parts[5])
                write_sectors = int(parts[9])
                result[dev] = (read_sectors, write_sectors)
        return result
    except Exception:
        return None


def io_percent_linux() -> Optional[float]:
    global _prev_diskstats, _prev_diskstats_ts
    cur = _read_diskstats()
    now = time.time()
    if cur is None:
        return None

    if _prev_diskstats is None or _prev_diskstats_ts is None:
        _prev_diskstats = cur
        _prev_diskstats_ts = now
        return 0.0

    dt = now - _prev_diskstats_ts
    if dt <= 0:
        return None

    delta_sectors = 0
    for dev, (r, w) in cur.items():
        prev = _prev_diskstats.get(dev)
        if prev is None:
            continue
        pr, pw = prev
        dr = max(0, r - pr)
        dw = max(0, w - pw)
        delta_sectors += dr + dw

    _prev_diskstats = cur
    _prev_diskstats_ts = now

    bytes_per_sec = (delta_sectors * 512) / dt
    # 100MB/s를 100% 기준으로 표시
    percent = (bytes_per_sec / (100 * 1024 * 1024)) * 100.0
    return clamp(percent, 0.0, 100.0)


def disk_io_bytes_linux() -> Tuple[Optional[int], Optional[int]]:
    cur = _read_diskstats()
    if cur is None:
        return None, None
    read_sectors_total = 0
    write_sectors_total = 0
    for _, (r, w) in cur.items():
        read_sectors_total += r
        write_sectors_total += w
    return read_sectors_total * 512, write_sectors_total * 512


def get_local_metrics() -> dict:
    cpu = None
    mem_percent = None
    mem_free_gb = None
    disk_percent = None
    io_percent = None
    io_read_bytes = None
    io_write_bytes = None

    system = platform.system().lower()
    if psutil is not None:
        try:
            cpu = float(psutil.cpu_percent(interval=0.1))
        except Exception:
            cpu = None
        try:
            vm = psutil.virtual_memory()
            mem_percent = float(vm.percent)
            mem_free_gb = round(float(vm.available) / (1024**3), 2)
        except Exception:
            mem_percent = None
            mem_free_gb = None
        try:
            a = psutil.disk_io_counters()
            ta = time.time()
            time.sleep(0.2)
            b = psutil.disk_io_counters()
            tb = time.time()
            dt = tb - ta
            if dt > 0:
                bytes_per_sec = ((b.read_bytes - a.read_bytes) + (b.write_bytes - a.write_bytes)) / dt
                io_percent = clamp((bytes_per_sec / (100 * 1024 * 1024)) * 100.0, 0.0, 100.0)
            c = psutil.disk_io_counters()
            io_read_bytes = int(getattr(c, "read_bytes", 0))
            io_write_bytes = int(getattr(c, "write_bytes", 0))
        except Exception:
            io_percent = None
    elif system == "linux":
        cpu = cpu_percent_sample()
        mem_percent, mem_free_gb = memory_percent_linux()
        io_percent = io_percent_linux()
        io_read_bytes, io_write_bytes = disk_io_bytes_linux()

    try:
        path = "/" if system == "linux" else os.getcwd()
        total, used, free = shutil.disk_usage(path)
        disk_percent = clamp(used / total * 100.0, 0.0, 100.0)
    except Exception:
        disk_percent = None

    def _nz(v: Optional[float]) -> float:
        return float(v) if v is not None else 0.0

    return {
        "cpu_percent": round(_nz(cpu), 2),
        "memory_percent": round(_nz(mem_percent), 2),
        "memory_free_gb": mem_free_gb,
        "disk_percent": round(_nz(disk_percent), 2),
        "io_percent": round(_nz(io_percent), 2) if io_percent is not None else 0.0,
        "io_read_bytes": int(io_read_bytes) if io_read_bytes is not None else 0,
        "io_write_bytes": int(io_write_bytes) if io_write_bytes is not None else 0,
        "updated_at": int(time.time() * 1000),
        "host": platform.node(),
        "os": platform.system(),
    }


class AgentHandler(BaseHTTPRequestHandler):
    server_version = "S2WAgent/1.0"

    def _send_json(self, obj: dict, status: int = 200) -> None:
        try:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except Exception:
            return

    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/health"):
            self._send_json({"ok": True, "ts": int(time.time() * 1000)})
            return
        if parsed.path == DEFAULT_PATH:
            metrics = get_local_metrics()
            _maybe_log_metrics(metrics)
            self._send_json(metrics)
            return
        if parsed.path == "/logs":
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.end_headers()

                def send_line(line: str) -> bool:
                    try:
                        payload = f"data: {line}\n\n".encode("utf-8")
                        self.wfile.write(payload)
                        self.wfile.flush()
                        return True
                    except Exception:
                        return False

                with _log_cv:
                    snapshot = list(_log_buf)[-60:]
                    last_seq = snapshot[-1][0] if snapshot else 0

                if not send_line("[logs] connected"):
                    return
                for _, line in snapshot:
                    if not send_line(line):
                        return

                while True:
                    with _log_cv:
                        _log_cv.wait(timeout=10)
                        current = list(_log_buf)
                    for seq, line in current:
                        if seq <= last_seq:
                            continue
                        last_seq = seq
                        if not send_line(line):
                            return
            except Exception:
                pass
            return

        self._send_json({"error": "not found"}, status=404)

    def do_OPTIONS(self) -> None:
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()
        except Exception:
            pass


def run_agent_server(host: str, port: int) -> None:
    httpd = ThreadingHTTPServer((host, port), AgentHandler)
    _log(f"agent start http://{host}:{port}{DEFAULT_PATH} (logs: /logs)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def latency_to_io_percent(latency_sec: float) -> float:
    return clamp(latency_sec * 100.0, 0.0, 100.0)


def fetch_metrics(url: str) -> Tuple[Optional[dict], float]:
    start = time.time()
    try:
        response = requests.get(url, timeout=5)
        latency = time.time() - start
        if response.status_code != 200:
            return None, latency
        return response.json(), latency
    except Exception:
        return None, time.time() - start


def print_metrics(data: dict, latency: float) -> None:
    cpu = data.get("cpu_percent")
    ram = data.get("memory_percent")
    ram_free = data.get("memory_free_gb")
    disk = data.get("disk_percent")

    io = data.get("io_percent")
    if io is None:
        io = latency_to_io_percent(latency)

    print("--------------------------------")
    print(f"⏱️ latency: {latency:.3f}s")
    print(f"💻 CPU    : {cpu}%")
    if ram_free is not None:
        print(f"🧠 RAM    : {ram}% (여유: {ram_free}GB)")
    else:
        print(f"🧠 RAM    : {ram}%")
    print(f"💾 DISK   : {disk}%")
    print(f"📀 IO     : {io}%")


def mb_per_sec(delta_bytes: int, dt_sec: float) -> float:
    if dt_sec <= 0:
        return 0.0
    return (delta_bytes / 1024 / 1024) / dt_sec


def monitor_loop(url: str, poll_seconds: int, stop_event: threading.Event) -> None:
    print(f"[poll] 모니터링 시작: {url}")
    prev_read = None
    prev_write = None
    prev_ts = None
    while not stop_event.is_set():
        try:
            data, latency = fetch_metrics(url)
            if data is None:
                print(f"⚠️ 서버 에러 또는 연결 실패 ({latency:.3f}s)")
            else:
                print_metrics(data, latency)
                curr_read = data.get("io_read_bytes")
                curr_write = data.get("io_write_bytes")
                now = time.time()
                
                # I/O 속도 계산 (서버에서 받은 누적 바이트 차이 계산)
                if isinstance(curr_read, (int, float)) and isinstance(curr_write, (int, float)):
                    read_speed = 0.0
                    write_speed = 0.0
                    
                    if prev_read is not None and prev_write is not None and prev_ts is not None:
                        dt = now - prev_ts
                        if dt > 0:
                            # 만약 서버 재시작으로 수치가 초기화되었으면(음수 발생) 0으로 처리
                            dr = max(0, int(curr_read) - int(prev_read))
                            dw = max(0, int(curr_write) - int(prev_write))
                            read_speed = mb_per_sec(dr, dt)
                            write_speed = mb_per_sec(dw, dt)

                    print(f"🚀 I/O R  : {read_speed:.2f} MB/s")
                    print(f"🚀 I/O W  : {write_speed:.2f} MB/s")

                    prev_read = int(curr_read)
                    prev_write = int(curr_write)
                    prev_ts = now
        except Exception as e:
            print(f"🚨 모니터링 에러: {e}")
        
        time.sleep(poll_seconds)


def run_aws_cli(cmdline: str) -> None:
    cmdline = cmdline.strip()
    if not cmdline:
        return
    if not cmdline.startswith("aws"):
        print("⚠️ aws 로 시작하는 명령만 실행합니다.")
        return

    try:
        completed = subprocess.run(cmdline, shell=True, text=True, capture_output=True)
        if completed.stdout:
            print(completed.stdout.rstrip())
        if completed.stderr:
            print(completed.stderr.rstrip())
        print(f"(exit {completed.returncode})")
    except FileNotFoundError:
        print("🚨 AWS CLI(aws)가 설치되어 있지 않습니다. 설치 후 PATH에 aws가 있어야 합니다.")
    except Exception as e:
        print(f"🚨 실행 실패: {e}")


def cli_loop(stop_event: threading.Event) -> None:
    print("\n[AWS CLI] 여기서 aws 명령을 실행할 수 있어요.")
    print("- 예: aws sts get-caller-identity")
    print("- 종료: exit\n")
    while not stop_event.is_set():
        try:
            line = input("aws> ").strip()
        except (EOFError, KeyboardInterrupt):
            stop_event.set()
            break
        if line.lower() in ("exit", "quit"):
            stop_event.set()
            break
        run_aws_cli(line)


def run_poll_and_cli(url: str, poll_seconds: int) -> None:
    stop_event = threading.Event()
    t = threading.Thread(target=monitor_loop, args=(url, poll_seconds, stop_event), daemon=True)
    t.start()
    cli_loop(stop_event)
    stop_event.set()
    t.join(timeout=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=["agent", "poll"],
        default="agent",
        help="agent: 이 머신에서 /monitor 제공 | poll: 원격 /monitor 폴링 + 로컬 aws cli",
    )
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--ip", default=DEFAULT_REMOTE_IP, help="poll 모드에서 대상 IP")
    parser.add_argument("--poll-seconds", type=int, default=DEFAULT_POLL_SECONDS)
    args = parser.parse_args()

    if args.mode == "agent":
        run_agent_server(args.host, args.port)
        return

    url = f"http://{args.ip}:{args.port}{DEFAULT_PATH}"
    run_poll_and_cli(url, args.poll_seconds)


if __name__ == "__main__":
    main()
