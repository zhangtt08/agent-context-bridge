#!/usr/bin/env bash
# 打包桌面便携版：release/ACB-win64（ACB.exe 双击即用）
# 自动构建：dist/（前端）与 dist-server/（服务端 JS），无需手动前置
set -e
cd "$(dirname "$0")/.."
npm run build
npx tsc -p tsconfig.server.json
rm -rf release/ACB-win64 release/app
mkdir -p release/app release/ACB-win64

# 0. dist-server 是 tsc 编译的 CommonJS；显式标记，防止外层 "type": "module" 让 esbuild 按 ESM 误解析
printf '{ "type": "commonjs" }' > dist-server/package.json

# 1. 服务端单文件 bundle（内置 express/tar，无需 node_modules）
npx esbuild dist-server/server/index.js --bundle --platform=node --format=cjs --outfile=release/app/server.cjs --log-level=warning
npx esbuild dist-server/server/cli.js   --bundle --platform=node --format=cjs --outfile=release/app/cli.cjs   --log-level=warning

# 2. Electron 运行时
cp -r node_modules/electron/dist/. release/ACB-win64/
mv release/ACB-win64/electron.exe release/ACB-win64/ACB.exe

# 3. 应用本体
mkdir -p release/ACB-win64/resources/app
cp desktop/main.cjs desktop/preload.cjs release/app/server.cjs release/app/cli.cjs release/ACB-win64/resources/app/
cp build/icon.ico build/icon-256.png release/ACB-win64/resources/app/
cp -r dist release/ACB-win64/resources/app/dist
printf '{ "name": "acb", "productName": "ACB", "version": "0.1.0", "main": "main.cjs" }' > release/ACB-win64/resources/app/package.json
cp README-DESKTOP.txt release/ACB-win64/使用说明.txt 2>/dev/null || true

# 4. 精简：删除默认应用与多余语言包（保留 zh-CN / en-US）
rm -f release/ACB-win64/resources/default_app.asar
(cd release/ACB-win64/locales && ls | grep -vE "^(zh-CN|en-US)\.pak$" | xargs rm -f)

# 5. 图标与版本信息写入 exe
./node_modules/rcedit/bin/rcedit-x64.exe release/ACB-win64/ACB.exe \
  --set-icon build/icon.ico \
  --set-version-string "FileDescription" "ACB - Agent Context Bridge" \
  --set-version-string "ProductName" "ACB" \
  --set-version-string "CompanyName" "acb-local" \
  --set-version-string "LegalCopyright" "MIT" \
  --set-file-version "0.1.0" --set-product-version "0.1.0"

echo "完成: release/ACB-win64（双击 ACB.exe 运行）"
