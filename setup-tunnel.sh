#!/usr/bin/env bash
# Cloudflare Tunnel 一键配置:把本机 3002 端口暴露到 https://gaoxiao.1awa1.ccwu.cc
# 前置条件:一个能管理 gaoxiao.1awa1.ccwu.cc 的 Cloudflare 账号
# 用法: ./setup-tunnel.sh    (中途会打开浏览器让你登录 Cloudflare 授权)
# 注意:1awa1.ccwu.cc 本身是原来的 Pages 服务,不要占用;想换别的子域时改下面 HOSTNAME。
set -e
HOSTNAME="gaoxiao.1awa1.ccwu.cc"
TUNNEL_NAME="gaoxiao"
# 本机 3000-3001 被 snowluma 容器占用,网站监听 3002(与 start.sh 一致)
LOCAL_URL="http://127.0.0.1:3002"
cd "$(dirname "$0")"

# 1. cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[1/5] 未找到 cloudflared,正在安装(brew)..."
  brew install cloudflared
fi
echo "[1/5] cloudflared: $(cloudflared --version)"

# 2. 登录(浏览器授权)
echo "[2/5] 打开浏览器登录 Cloudflare(选择能管理 $HOSTNAME 的账号)..."
cloudflared tunnel login

# 3. 创建命名隧道(已存在则复用)
TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}')
if [ -z "$TUNNEL_ID" ]; then
  echo "[3/5] 创建隧道 $TUNNEL_NAME ..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}')
fi
echo "[3/5] 隧道 ID: $TUNNEL_ID"

# 4. DNS 路由
echo "[4/5] 绑定域名 $HOSTNAME ..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" \
  || echo "  ⚠ 域名路由失败:请确认 $HOSTNAME 已在你的 Cloudflare 账号名下,或在面板手动添加 CNAME $HOSTNAME → $TUNNEL_ID.cfargotunnel.com"

# 5. 写配置
CFG="$HOME/.cloudflared/config.yml"
cat > "$CFG" <<EOF
tunnel: $TUNNEL_NAME
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $HOSTNAME
    service: $LOCAL_URL
  - service: http_status:404
EOF
echo "[5/5] 配置已写入 $CFG"

echo
echo "==================== 启动方法 ===================="
echo "  终端1(启动网站):   GX_ADMIN_IDS=XXXXXXXX node server.mjs"
echo "  终端2(启动隧道):   cloudflared tunnel run $TUNNEL_NAME"
echo "  访问地址:          https://$HOSTNAME"
echo "=================================================="
