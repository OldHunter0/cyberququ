#!/bin/sh
# forge build 后运行：把 Arena ABI 导出到 ../shared/abi.ts（viem 需要 `as const` 才有类型推断）
set -e
cd "$(dirname "$0")"
~/.foundry/bin/forge build --silent
node -e '
const abi = require("./out/Arena.sol/Arena.json").abi;
const addr = process.env.ARENA_ADDRESS || "0x0000000000000000000000000000000000000000";
const src = `// 由 contracts/export-abi.sh 生成，不要手改\nexport const ARENA_ADDRESS = "${addr}" as const;\n\nexport const arenaAbi = ${JSON.stringify(abi, null, 2)} as const;\n`;
require("fs").writeFileSync("../shared/abi.ts", src);
console.log("wrote shared/abi.ts,", abi.length, "entries");
'
