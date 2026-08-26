#!/usr/bin/env bash
# 一键后台启动:网站(server.mjs) + Cloudflare 隧道(gaoxiao)
# 用法: ./start.sh
# 停止: ./stop.sh
# 管理员学号默认 XXXXXXXX,可用环境变量覆盖:GX_ADMIN_IDS=12345678 ./start.sh
cd "$(dirname "$0")"

# 停掉可能残留的旧进程,避免端口/隧道冲突
pkill -f 'node server.mjs' 2>/dev/null && echo "已停止旧 server" || true
pkill -f 'cloudflared tunnel run gaoxiao' 2>/dev/null && echo "已停止旧隧道" || true
sleep 1

export GX_ADMIN_IDS="${GX_ADMIN_IDS:-XXXXXXXX}"
# 若默认 3000 端口被占用可改监听端口(示例 3002),需与隧道配置保持一致
PORT=3002 nohup node server.mjs > server.log 2>&1 &
echo $! > server.pid
nohup cloudflared tunnel run gaoxiao > tunnel.log 2>&1 &
echo $! > tunnel.pid

sleep 4
echo "server  pid=$(cat server.pid)  日志: server.log"
echo "tunnel  pid=$(cat tunnel.pid)  日志: tunnel.log"
curl -s -o /dev/null -w "本地检查 http://127.0.0.1:3002/login -> HTTP %{http_code}\n" http://127.0.0.1:3002/login || echo "本地检查失败,请查看 server.log"
