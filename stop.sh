#!/usr/bin/env bash
# 停止网站和隧道
pkill -f 'node server.mjs' 2>/dev/null && echo "server 已停止" || echo "server 未在运行"
pkill -f 'cloudflared tunnel run gaoxiao' 2>/dev/null && echo "tunnel 已停止" || echo "tunnel 未在运行"
