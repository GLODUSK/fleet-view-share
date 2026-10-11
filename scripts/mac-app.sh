#!/usr/bin/env bash
# Fleet View for macOS: builds the app bundle ~/Applications/Fleet View.app from this checkout. install.sh runs it,
# and so does an update that changes what the bundle holds. Nothing is downloaded: it copies the Electron that
# `npm ci` put in desktop/node_modules, so macOS never quarantines it.
#   scripts/mac-app.sh                          build it, or leave it when it is up to date
#   scripts/mac-app.sh --force                  build it again anyway
#   scripts/mac-app.sh --check                  exit 0 when it is up to date, 1 when it needs a build
#   scripts/mac-app.sh --start-at-login         open it at login (~/Library/LaunchAgents/com.glodusk.fleetview.plist)
#   scripts/mac-app.sh --remove-start-at-login  stop that
# The bundle is Electron.app renamed: Info.plist says Fleet View (com.glodusk.fleetview), the icon is drawn by
# desktop/icon.js (node writes the PNGs, iconutil makes the .icns), and Contents/Resources/app holds a package.json
# and a main.js that loads <this checkout>/desktop/main.js. So the bundle runs this folder's code as it is: a pull
# needs no new bundle; a new Electron (desktop/package-lock.json), this script or the icon does. The bundle is then
# signed ad hoc (codesign --sign -): Apple Silicon won't start a binary whose signature broke when Info.plist changed.
# main.js takes PATH from the login shell itself (platform.js applyLoginPath), so the app finds claude, git and gh
# when it is started from Finder, the dock or at login.
# FLEET_VIEW_APP puts the bundle somewhere else (tests). Exit codes: 0 done or up to date, 1 failed, 2 not macOS.
set -euo pipefail

say() { printf '  %s\n' "$*"; }
die() { printf '  %s\n' "$*" >&2; exit 1; }

# this script's folder, through any symlink to it
self=${BASH_SOURCE[0]}
while [ -L "$self" ]; do
  l=$(readlink "$self")
  case $l in /*) self=$l ;; *) self=$(dirname "$self")/$l ;; esac
done
ROOT=$(cd "$(dirname "$self")/.." && pwd -P)
DESK="$ROOT/desktop"
APP=${FLEET_VIEW_APP:-"$HOME/Applications/Fleet View.app"}
APP=${APP%/}
DATA="$HOME/Library/Application Support/fleet-view"
STAMP="$DATA/mac-app.stamp"
AGENT="$HOME/Library/LaunchAgents/com.glodusk.fleetview.plist"
ID=com.glodusk.fleetview

[ "$(uname -s)" = Darwin ] || { say 'Fleet View.app is for macOS only.'; exit 2; }

case ${1:-} in
  --start-at-login)
    [ -d "$APP" ] || die "There is no $APP yet: run install.sh first."
    mkdir -p "$(dirname "$AGENT")"
    # the path goes in as XML text
    esc=$(printf '%s' "$APP" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$ID</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>$esc</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
    say "Fleet View opens at login ($AGENT)"
    exit 0 ;;
  --remove-start-at-login)
    launchctl bootout "gui/$(id -u)/$ID" >/dev/null 2>&1 || true
    if [ -f "$AGENT" ]; then rm -f "$AGENT"; say 'Fleet View no longer opens at login'; else say 'Fleet View was not set to open at login'; fi
    exit 0 ;;
esac
force=0 check=0
for a in "$@"; do
  case $a in
    --force) force=1 ;;
    --check) check=1 ;;
    *) die "unknown option: $a" ;;
  esac
done

SRC="$DESK/node_modules/electron/dist/Electron.app"
[ -d "$SRC" ] || die 'Electron is not installed in desktop/ yet (install.sh runs npm ci there first).'
command -v node >/dev/null 2>&1 || die 'node is missing.'

# what the bundle is made from: the Electron version, this script, the icon, the checkout and the bundle's place
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
electron=$(node -p "require(process.argv[1]).version" "$DESK/node_modules/electron/package.json")
want="$electron|$(sha "$ROOT/scripts/mac-app.sh")|$(sha "$DESK/icon.js")|$ROOT|$APP"
have=$(cat "$STAMP" 2>/dev/null || true)
fresh=0
[ "$have" = "$want" ] && [ -f "$APP/Contents/Resources/app/main.js" ] && [ -x "$APP/Contents/MacOS/Electron" ] && fresh=1
if [ "$check" = 1 ]; then [ "$fresh" = 1 ] && exit 0; exit 1; fi
if [ "$fresh" = 1 ] && [ "$force" = 0 ]; then say "Fleet View.app is up to date ($APP)"; exit 0; fi

# The bundle is replaced and the old one deleted, so $APP must be an app bundle's path, and what is there now must be
# Fleet View's own (FLEET_VIEW_APP can name any folder; ~/Applications itself would lose every app in it)
case $APP in
  *.app) ;;
  *) die "FLEET_VIEW_APP must be the path of the app bundle itself (ending in .app, like ~/Applications/Fleet View.app), not $APP. Nothing was changed." ;;
esac
if [ -e "$APP" ] || [ -L "$APP" ]; then
  bid=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)
  [ "$bid" = "$ID" ] || die "$APP is there and is not Fleet View's app (its bundle id is ${bid:-missing}), so it was left as it is. Move it away, or set FLEET_VIEW_APP to another path ending in .app."
fi

say "Building Fleet View.app (Electron $electron)..."
parent=$(dirname "$APP")
mkdir -p "$parent"
TMP="$parent/.Fleet View.app.new-$$"
OLD="$parent/.Fleet View.app.old-$$"
ICONS=$(mktemp -d "${TMPDIR:-/tmp}/fleet-view-icon.XXXXXX")
cleanup() { rm -rf "$TMP" "$ICONS"; }
trap cleanup EXIT
rm -rf "$TMP"
ditto "$SRC" "$TMP"
xattr -cr "$TMP" 2>/dev/null || true

ver=$(node "$ROOT/version.js" 2>/dev/null || true)
[ -n "$ver" ] || ver=1.0
PL="$TMP/Contents/Info.plist"
plutil -replace CFBundleName -string 'Fleet View' "$PL"
plutil -replace CFBundleDisplayName -string 'Fleet View' "$PL"
plutil -replace CFBundleIdentifier -string "$ID" "$PL"
plutil -replace CFBundleShortVersionString -string "$ver" "$PL"
plutil -replace CFBundleVersion -string "$ver" "$PL"
plutil -replace LSApplicationCategoryType -string public.app-category.developer-tools "$PL"
# what macOS says when it asks: the chat box's mic, and Terminal or iTerm2 for "Open in terminal"
plutil -replace NSMicrophoneUsageDescription -string 'Fleet View uses the microphone for voice input in the chat box.' "$PL"
plutil -replace NSAppleEventsUsageDescription -string 'Fleet View opens conversations in Terminal or iTerm2.' "$PL"
plutil -remove CFBundleIconName "$PL" >/dev/null 2>&1 || true

# the icon: every size an .iconset needs, with the margin round the tile a macOS app icon has
mkdir -p "$ICONS/fleet-view.iconset"
if node -e '
const fs = require("fs"), path = require("path");
const { iconPng } = require(process.argv[1]);
const out = process.argv[2];
for (const n of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(out, `icon_${n}x${n}.png`), iconPng(n, { inset: 0.07 }));
  fs.writeFileSync(path.join(out, `icon_${n}x${n}@2x.png`), iconPng(n * 2, { inset: 0.07 }));
}' "$DESK/icon.js" "$ICONS/fleet-view.iconset" && iconutil -c icns -o "$TMP/Contents/Resources/fleet-view.icns" "$ICONS/fleet-view.iconset"; then
  plutil -replace CFBundleIconFile -string fleet-view.icns "$PL"
else
  say 'Could not make the icon; the app keeps the Electron icon.'
fi

# Contents/Resources/app: Electron runs this instead of its default app; it loads this checkout's desktop/main.js
mkdir -p "$TMP/Contents/Resources/app"
node -e '
const fs = require("fs"), path = require("path");
const [dir, root, ver] = process.argv.slice(1);
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fleet-view", productName: "Fleet View", version: /^\d+\.\d+\.\d+$/.test(ver) ? ver : "1.0.0", private: true, main: "main.js" }, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "main.js"), `// Fleet View.app (made by scripts/mac-app.sh): runs the desktop window of the Fleet View checkout below.
"use strict";
const fs = require("fs");
const path = require("path");
const MAIN = path.join(${JSON.stringify(root)}, "desktop", "main.js");
if (fs.existsSync(MAIN)) require(MAIN);
else {
  const { app, dialog } = require("electron");
  app.whenReady().then(() => {
    dialog.showErrorBox("Fleet View", "Fleet View is not in " + path.dirname(path.dirname(MAIN)) + " any more. Run its install.sh again from where it is now.");
    app.quit();
  });
}
`);
' "$TMP/Contents/Resources/app" "$ROOT" "$ver"

codesign --force --deep --sign - "$TMP" >/dev/null 2>&1 || die 'codesign failed: the app could not be signed (ad hoc).'
codesign --verify --deep --strict "$TMP" >/dev/null 2>&1 || die 'codesign --verify failed on the new app.'

# in place: a running Fleet View keeps the files it has open, and the next start uses the new bundle
if [ -e "$APP" ]; then mv "$APP" "$OLD"; fi
mv "$TMP" "$APP"
rm -rf "$OLD"
mkdir -p "$DATA"
printf '%s\n' "$want" > "$STAMP"
# Finder and the dock pick up the new name and icon
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1 || true
touch "$APP"
say "Fleet View.app ready ($APP)"
