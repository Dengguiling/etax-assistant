#!/usr/bin/env bash
# release.sh —— 打包发布版本
#
# 用法：
#   ./scripts/release.sh 1.0.1 "修复登录页改版匹配"
#
# 做的事：
#   1. 把版本号写入 manifest.json
#   2. 把整个插件打成 zip（剔除 .git/scripts/sample 等）
#   3. 生成 update.json（供插件自更新检测）
#   4. 打印发版步骤（创建 GitHub Release、上传两个文件）
#
# 注意：update.json 和 zip 都要上传到同一个 GitHub Release 的 Assets 里，
#       因为 update.json 里的 url 指向同 Release 的 zip 下载地址。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -lt 1 ]; then
  echo "用法: ./scripts/release.sh <版本号> [更新说明]"
  echo "示例: ./scripts/release.sh 1.0.1 \"修复登录页改版匹配\""
  exit 1
fi

VERSION="$1"
NOTE="${2:-}"
ROOT="$(pwd)"
DIST="$ROOT/dist"
REPO_SLUG="$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]##; s#\.git$##' || echo 'Dengguiling/etax-assistant')"

echo "==> 仓库: $REPO_SLUG"
echo "==> 版本: $VERSION"
echo "==> 说明: ${NOTE:-(无)}"

# 1. 写版本号到 manifest.json
if command -v python3 >/dev/null 2>&1; then
  python3 - "$VERSION" <<'PY'
import json, sys
v = sys.argv[1]
with open('manifest.json', 'r', encoding='utf-8') as f:
    m = json.load(f)
m['version'] = v
with open('manifest.json', 'w', encoding='utf-8') as f:
    json.dump(m, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('manifest.json version ->', v)
PY
else
  echo "需要 python3 来更新 manifest 版本号"; exit 1
fi

# 2. 打 zip
rm -rf "$DIST"
mkdir -p "$DIST"
STAGE="$DIST/etax-assistant"
mkdir -p "$STAGE"
# 排除非插件文件
rsync -a --exclude='.git' --exclude='.gitignore' --exclude='dist' \
  --exclude='scripts' --exclude='sample' --exclude='.DS_Store' \
  "$ROOT/" "$STAGE/"
ZIPNAME="etax-assistant-v${VERSION}.zip"
( cd "$DIST" && zip -qr "$ZIPNAME" "etax-assistant" )
echo "==> 打包完成: dist/$ZIPNAME"

# 3. 生成 update.json
#    url 用 latest/download 固定路径，确保始终指向最新 Release
cat > "$DIST/update.json" <<EOF
{
  "latest": "${VERSION}",
  "url": "https://github.com/${REPO_SLUG}/releases/latest/download/${ZIPNAME}",
  "note": "${NOTE}",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "==> 生成: dist/update.json"
cat "$DIST/update.json"

# 4. 计算 zip 的 sha256（可选，用于校验完整性）
if command -v shasum >/dev/null 2>&1; then
  SHA="$(shasum -a 256 "$DIST/$ZIPNAME" | awk '{print $1}')"
  echo ""
  echo "zip sha256: $SHA"
  echo "（如需校验，可把 sha256 字段加入 update.json）"
fi

cat <<EOF

==> ✅ 打包完成，接下来发布到 GitHub：

  1) 提交代码并打 tag：
     git add -A
     git commit -m "release: v${VERSION}"
     git tag "v${VERSION}"
     git push origin main --tags

  2) 创建 Release（用 gh CLI，会自动用上面的 tag）：
     gh release create "v${VERSION}" \\
       --title "v${VERSION}" \\
       --notes "${NOTE}" \\
       "dist/${ZIPNAME}" "dist/update.json"

  发布后，已安装的插件会在 24 小时内检测到新版本并提示会计一键更新。
EOF
