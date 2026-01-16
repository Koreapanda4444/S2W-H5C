# 파일명: client.py (내 컴퓨터에 저장)
import requests
import time

# ==========================================
# [주의] 본인의 EC2 퍼블릭 IP로 꼭 바꾸세요!
EC2_IP = "3.36.74.135" 
# ==========================================

URL = f"http://{EC2_IP}:5000/monitor"

print(f"📡 EC2({EC2_IP}) 모니터링을 시작합니다...")

while True:
    try:
        a = time.time()
        # 1. EC2 서버에 GET 요청 보내기
        response = requests.get(URL, timeout=5)
        print(time.time()-a)
        
        # 2. 응답 상태 확인
        if response.status_code == 200:
            data = response.json()
            
            # 데이터 예쁘게 출력
            print(f"--------------------------------")
            print(f"💻 CPU    : {data['cpu_percent']}%")
            print(f"🧠 RAM    : {data['memory_percent']}% (여유: {data['memory_free_gb']}GB)")
            print(f"💾 DISK   : {data['disk_percent']}%")
            print(data)
        else:
            print(f"⚠️ 서버 에러: {response.status_code}")
            
    except requests.exceptions.ConnectionError:
        print("🚨 연결 실패! (EC2 서버가 켜져 있는지, 보안그룹 5000번이 열려있는지 확인하세요)")
    
    # 3초마다 반복
    time.sleep(1)
    