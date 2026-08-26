#!/usr/bin/env bash
# Package Chomir (重明丽正，以鉴万码) + ChomirCode agent + AIFront for macOS trial.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:-$(uname -m | sed 's/x86_64/x64/')}"
BUILD_DIR="$(dirname "$ROOT")"
APP_FOLDER="VSCode-darwin-${ARCH}"
APP_NAME="$(node -pe "require('$ROOT/product.json').nameLong")"
DIST_DIR="$ROOT/dist/macos-trial"
STAMP="$(date +%Y%m%d-%H%M)"

export N_PREFIX="${N_PREFIX:-$HOME/.n}"
export PATH="$N_PREFIX/bin:$PATH"

if [[ ! -d "$ROOT/extensions/copilot/node_modules" ]]; then
	echo "==> Installing Copilot extension dependencies (required for packaging)…"
	( cd "$ROOT/extensions/copilot" && npm install )
fi

echo "==> Building macOS client (${ARCH})…"
cd "$ROOT"
npm run gulp "vscode-darwin-${ARCH}-min"

APP_PATH="$BUILD_DIR/$APP_FOLDER/${APP_NAME}.app"
RESOURCES_APP="$APP_PATH/Contents/Resources/app"
AIFRONT_DEST="$RESOURCES_APP/AIFront"

if [[ ! -d "$APP_PATH" ]]; then
	echo "Expected app not found: $APP_PATH" >&2
	exit 1
fi

echo "==> Bundling AIFront engine (excluding .panda cache)…"
rm -rf "$AIFRONT_DEST"
mkdir -p "$AIFRONT_DEST"
rsync -a --delete \
	--exclude '.panda/' \
	--exclude '.git/' \
	--exclude 'node_modules/.cache/' \
	"$ROOT/AIFront/" "$AIFRONT_DEST/"

# Modifying the .app after Electron packaging invalidates signatures; macOS then
# kills helpers with SIGKILL (window terminated, reason: killed, code: 9).
echo "==> Ad-hoc codesign (required after bundling AIFront)…"
xattr -cr "$APP_PATH" 2>/dev/null || true
codesign --force --deep --sign - "$APP_PATH"

mkdir -p "$DIST_DIR"

ZIP_NAME="Chomir-macOS-${ARCH}-${STAMP}.zip"
DMG_NAME="Chomir-macOS-${ARCH}-${STAMP}.dmg"

echo "==> Creating zip: $DIST_DIR/$ZIP_NAME"
(
	cd "$BUILD_DIR/$APP_FOLDER"
	zip -r -y "$DIST_DIR/$ZIP_NAME" "${APP_NAME}.app"
)

echo "==> Creating DMG: $DIST_DIR/$DMG_NAME"
if [[ -d "$APP_PATH" ]]; then
	hdiutil create -volname "Chomir" -srcfolder "$APP_PATH" -ov -format UDZO "$DIST_DIR/$DMG_NAME"
else
	echo "Skip DMG: app not found at $APP_PATH" >&2
fi

echo ""
echo "Done."
echo "  App:  $APP_PATH"
echo "  Zip:  $DIST_DIR/$ZIP_NAME"
echo "  DMG:  $DIST_DIR/$DMG_NAME"
echo ""
echo "Chomir — 重明丽正，以鉴万码"
echo "After install run: xattr -cr \"/Applications/${APP_NAME}.app\""
echo "Then right-click → Open. Configure: ChomirCode: Manage Models."
echo "App name: ${APP_NAME}.app"
