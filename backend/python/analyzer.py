import json
import sys

def verdict(m):
    cpu = float(m.get("cpu", 0))
    ram = float(m.get("ram", 0))
    temp = float(m.get("temp", 0))
    net = float(m.get("net", 0))
    errors = float(m.get("errors", 0))

    hot = temp >= 80
    warm = temp >= 75
    heavy = cpu >= 85 or ram >= 85
    lag = net >= 250
    err = errors >= 25

    if hot or (lag and err and heavy):
        return {
            "emoji": "😡",
            "statusText": "위험",
            "hint": "즉시 안정화 조치가 필요합니다.",
            "actions": [
                "냉각 강화(팬/냉각수) + 핫노드 격리",
                "부하 분산(로드밸런싱/오토스케일)",
                "레이트리밋 적용(폭주 트래픽 제한)",
                "문제 서비스 안전 재시작(컨테이너/프로세스)"
            ]
        }

    if warm or heavy or net >= 180 or errors >= 12:
        return {
            "emoji": "🤨",
            "statusText": "주의",
            "hint": "확산 전에 선제 대응을 권장합니다.",
            "actions": [
                "부하 분산 검토(트래픽 분산/스케일아웃)",
                "메모리/핸들 누수 의심 서비스 점검",
                "디스크/네트워크 병목 모니터링 강화"
            ]
        }

    if cpu <= 35 and ram <= 35 and temp <= 55 and net <= 80 and errors <= 2:
        return {
            "emoji": "😎",
            "statusText": "최상",
            "hint": "운영이 아주 안정적입니다.",
            "actions": [
                "유지",
                "에너지 최적화(저부하 구간 전력 절감 정책 적용)"
            ]
        }

    return {
        "emoji": "🙂",
        "statusText": "정상",
        "hint": "모니터링 유지",
        "actions": ["정상 운영", "추세 변화 감시"]
    }


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"error": "no input"}, ensure_ascii=False))
        sys.exit(1)

    m = json.loads(raw)
    out = verdict(m)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
