#!/bin/zsh
# 本地展示端：引擎（:8787）+ 前端（:3000），大屏打开 http://localhost:3000/screen
# 参数都可用环境变量覆盖，例如：REAL_PLAYER_LIMIT=4 BOT_COUNT=8 ./run-local.sh
# 运行中调整：curl -X POST "localhost:8787/admin/config?realLimit=3&bots=4"（大屏右下角也有按钮）
cd "$(dirname "$0")"
mkdir -p .run
export LOBBY_SECONDS=${LOBBY_SECONDS:-60}
export ROUND_MS=${ROUND_MS:-6000}
export HOUSE_COUNT=${HOUSE_COUNT:-4}
export BOT_COUNT=${BOT_COUNT:-6}
export REAL_PLAYER_LIMIT=${REAL_PLAYER_LIMIT:-2}
export AUTO_NEXT_SECONDS=${AUTO_NEXT_SECONDS:-45}

lsof -ti tcp:8787 tcp:3000 | xargs kill 2>/dev/null
(cd engine && node_modules/.bin/tsx loop.ts) > .run/engine.log 2>&1 &
ENGINE=$!
(cd web && node_modules/.bin/next start -H 0.0.0.0 -p 3000) > .run/web.log 2>&1 &
WEB=$!
trap "kill $ENGINE $WEB 2>/dev/null" EXIT INT TERM
echo "engine pid $ENGINE → .run/engine.log ; web pid $WEB → .run/web.log"
echo "大屏：http://localhost:3000/screen   手机：https://cyber-cricket-arena-ten.vercel.app"
wait
