ssh -i "Test.pem" ubuntu@[server_ip] - 서버 연결

nohup python3 cputest.py > /dev/null 2>&1 & # cpu 점유 - cputest.py 파일을 백그라운드에서 돌리기

python3 server.py - server.py파일을 실행하기

scp -i Test.pem "C:\Users\34-12\Desktop\무제1" ubuntu@3.36.74.135:/home/ubuntu - 무제1 파일을 업로드

ps -ef | grep python - 현재 켜져있는 프로세스 보기