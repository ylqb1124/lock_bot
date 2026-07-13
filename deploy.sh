#!/bin/bash
# deploy.sh — 一键部署监控仪表盘到新环境
# 用法: bash deploy.sh

set -e

echo "========================================"
echo "  开发机集群资源监控 — 部署脚本"
echo "========================================"
echo ""

# 优先使用当前开发机已安装的 NVM Node；确保 npm 的子进程也能找到 node。
NVM_NODE_BIN="${NVM_NODE_BIN:-/home/users/v_qiujie04/.nvm/versions/node/v22.23.1/bin}"
if [ -x "$NVM_NODE_BIN/node" ]; then
  export PATH="$NVM_NODE_BIN:$PATH"
fi

# 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "❌ 未安装 Node.js，请先安装: https://nodejs.org/"
  exit 1
fi

echo "✓ Node.js $(node -v)"

# 定位脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 检查必要文件
for f in proxy.js index.html api.js adapter.js; do
  if [ ! -f "$f" ]; then
    echo "❌ 缺少文件: $f"
    exit 1
  fi
done
echo "✓ 所有必要文件就绪"

# 构建独立 Vue 页面。生产环境仍只运行 proxy.js，/app/ 由其托管。
if [ -f "web/package.json" ]; then
  echo "✓ 构建 /app/ 前端"
  (
    cd web
    if [ -f package-lock.json ]; then
      npm ci
    else
      npm install
    fi
    npm run build
  )
fi

# config.json 处理
if [ ! -f "config.json" ]; then
  if [ -f "config.example.json" ]; then
    cp config.example.json config.json
    echo "✓ 已从 config.example.json 创建 config.json"
    echo ""
    echo "⚠️  请编辑 config.json 填入实际的服务器地址:"
    echo "   vim config.json"
    echo ""
  else
    echo "⚠️  config.example.json 不存在，将使用 proxy.js 内置默认值"
  fi
else
  echo "✓ config.json 已存在"
fi

echo ""
echo "========================================"
echo "  启动代理服务..."
echo "========================================"
echo ""

# 支持 PORT 环境变量覆盖
if [ -n "$PORT" ]; then
  export PROXY_PORT="$PORT"
fi

exec node proxy.js
