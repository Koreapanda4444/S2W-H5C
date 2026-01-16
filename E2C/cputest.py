import time
import math
from multiprocessing import Process, cpu_count

# --- 설정 ---
PERIOD = 60             # 주기 (초)
CYCLE_DURATION = 0.1    # 제어 주기 (초)

def cpu_worker(period, cycle_duration):
    start_time = time.time()
    try:
        while True:
            elapsed = time.time() - start_time
            # 사인파 계산 (0.0 ~ 1.0)
            load_factor = (math.sin(2 * math.pi * elapsed / period) + 1) / 2
            
            work_time = cycle_duration * load_factor
            sleep_time = cycle_duration - work_time
            
            # Busy Wait
            end_time = time.time() + work_time
            while time.time() < end_time:
                pass
                
            if sleep_time > 0:
                time.sleep(sleep_time)
    except KeyboardInterrupt:
        pass

def main():
    num_cores = cpu_count()
    print(f"=== CPU Stress Test Only ===")
    print(f"Cores: {num_cores}")
    print(f"Period: {PERIOD}s")
    print("Press Ctrl+C to stop.\n")

    processes = []
    for _ in range(num_cores):
        p = Process(target=cpu_worker, args=(PERIOD, CYCLE_DURATION))
        p.daemon = True
        p.start()
        processes.append(p)

    # 메인 프로세스는 현재 부하 상태를 출력만 함
    start_time = time.time()
    try:
        while True:
            elapsed = time.time() - start_time
            load_factor = (math.sin(2 * math.pi * elapsed / PERIOD) + 1) / 2
            
            # 터미널에 현재 부하율 표시 (게이지 바 형태)
            bar_len = 20
            filled_len = int(bar_len * load_factor)
            bar = '█' * filled_len + '-' * (bar_len - filled_len)
            print(f"\rCPU Load: [{bar}] {load_factor*100:.1f}%", end="")
            
            time.sleep(0.5)
            
    except KeyboardInterrupt:
        print("\nStopping CPU test...")
        for p in processes:
            p.terminate()

if __name__ == "__main__":
    main()