#!/usr/bin/env bash
# Fleet View installer for macOS (Linux: best effort). Run it once, and again to update (it pulls first):
#   curl -fsSL https://raw.githubusercontent.com/GLODUSK/fleet-view-share/main/install.sh | bash
#   bash ~/fleet-view/install.sh [--start-at-login] [--remove-start-at-login] [--no-launch] [--no-desktop]
# Piped from curl it clones the share repo into ${FLEET_VIEW_DIR:-~/fleet-view} (branch ${FLEET_VIEW_BRANCH:-main}),
# or pulls it when it is there, and runs the install.sh in it. From a clone it uses that clone.
# It checks Node 18+, git and Claude Code, installs the desktop window's packages (desktop/: Electron and node-pty,
# with npm ci), builds ~/Applications/Fleet View.app from them (scripts/mac-app.sh), links fleet-view and fv into
# ~/.local/bin (and puts that folder on PATH in ~/.zprofile), installs the fleet-view skill and the fleet-view-feed
# mod into every Claude login (~/.claude and each ~/.claude-<letter>), and opens Fleet View.
# Run again while Fleet View runs, it puts the update in: when the desktop packages changed it asks to quit Fleet
# View first (the sessions open again when it starts); a changed session host or window restarts by itself.
# Nothing here needs sudo, and nothing leaves this machine: Fleet View reads your own ~/.claude and serves its page on
# 127.0.0.1 only. It has no cloud sync and no account of its own.
# Written for bash 3.2 (the one macOS ships).
#   --start-at-login          also open Fleet View at login (a LaunchAgent); --remove-start-at-login undoes it
#   --no-launch               don't open Fleet View at the end (one this script quit opens again anyway)
#   --no-desktop              no Electron window: Fleet View opens in a Chrome or Edge app window
#   --no-pull                 use the files as they are (CI, and the in-app update, which has pulled already)
#   --yes                     quit a running Fleet View without asking when the update needs that
#   --after-update [--from <commit>]   run by the in-app update (updater.js): --no-pull --yes, and what changed
#                             since <commit> restarts what it touches
set -euo pipefail

main() {
  SHARE_URL=${FLEET_VIEW_REPO:-https://github.com/GLODUSK/fleet-view-share.git}
  BRANCH=${FLEET_VIEW_BRANCH:-main}
  OS=$(uname -s)
  # Homebrew, the npm and Claude Code installers' usual places, for a shell that has not got them yet
  PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
  export PATH

  start_login=0 remove_login=0 no_launch=0 no_desktop=0 no_pull=0 yes=0 from=''
  # the options as given, for the install.sh a curl run clones (bash 3.2: an empty array needs the +)
  local args
  args=(${1+"$@"})
  while [ $# -gt 0 ]; do
    case $1 in
      --start-at-login) start_login=1 ;;
      --remove-start-at-login) remove_login=1 ;;
      --no-launch) no_launch=1 ;;
      --no-desktop) no_desktop=1 ;;
      --no-pull) no_pull=1 ;;
      --yes|-y) yes=1 ;;
      --after-update) no_pull=1; yes=1 ;;
      --from) shift; from=${1:-} ;;
      -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//'; return 0 ;;
      *) fail "unknown option: $1 (try --help)" ;;
    esac
    shift
  done

  case $OS in
    Darwin) ;;
    Linux) warn 'Linux: best effort (the window, terminals and the tray are untested there).' ;;
    *) fail "Fleet View's install.sh is for macOS (and Linux); on Windows run install.ps1." ;;
  esac
  need_git

  # ---------- where: this clone, or the share repo cloned (piped from curl) ----------
  DIR=''
  local src=${BASH_SOURCE[0]:-}
  if [ -n "$src" ] && [ -f "$src" ]; then
    while [ -L "$src" ]; do
      local l
      l=$(readlink "$src")
      case $l in /*) src=$l ;; *) src=$(dirname "$src")/$l ;; esac
    done
    local d
    d=$(cd "$(dirname "$src")" && pwd -P)
    [ -f "$d/fleet-view.js" ] && DIR=$d
  fi
  if [ -z "$DIR" ]; then
    local to=${FLEET_VIEW_DIR:-$HOME/fleet-view} was=''
    if [ -d "$to/.git" ]; then
      say "Updating $to"
      # where it was, so the install.sh below restarts what the pull changed in a running Fleet View (--from)
      was=$(git -C "$to" rev-parse HEAD 2>/dev/null || true)
      git -C "$to" pull --ff-only --quiet </dev/null || warn 'git pull failed (local changes?); carrying on with what is there.'
    elif [ -e "$to" ] && [ -n "$(ls -A "$to" 2>/dev/null)" ]; then
      fail "$to is there and is not a Fleet View clone. Move it, or pick another folder: FLEET_VIEW_DIR=~/somewhere bash"
    else
      say "Cloning Fleet View into $to"
      git clone --quiet --branch "$BRANCH" "$SHARE_URL" "$to" </dev/null || fail "git clone of $SHARE_URL failed (see above)."
    fi
    # the install.sh that came with it does the rest (it may be newer than this one)
    exec bash "$to/install.sh" --no-pull ${was:+--from "$was"} ${args[@]+"${args[@]}"}
  fi
  DESK="$DIR/desktop"
  APP=${FLEET_VIEW_APP:-"$HOME/Applications/Fleet View.app"}
  APP=${APP%/}
  # scripts/mac-app.sh replaces the bundle at $APP, and this script opens and quits it: never a folder that is not
  # Fleet View's app (FLEET_VIEW_APP can name any)
  if [ "$OS" = Darwin ]; then
    case $APP in
      *.app) ;;
      *) fail "FLEET_VIEW_APP must be the path of the app bundle itself (ending in .app, like ~/Applications/Fleet View.app), not $APP." ;;
    esac
    if [ -e "$APP" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)" != com.glodusk.fleetview ]; then
      fail "$APP is there and is not Fleet View's app; left as it is. Move it away, or set FLEET_VIEW_APP to another path ending in .app."
    fi
  fi
  if [ "$OS" = Darwin ]; then DATA="$HOME/Library/Application Support/fleet-view"; else DATA="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-view"; fi
  case $DATA in /*) ;; *) DATA="$HOME/.local/state/fleet-view" ;; esac

  printf '\n%sFleet View setup (%s)%s\n\n' "$CYAN" "$DIR" "$RESET"

  # ---------- what it needs ----------
  need_node
  if command -v claude >/dev/null 2>&1; then say 'Claude Code found'
  else warn 'Claude Code is not installed yet: npm i -g @anthropic-ai/claude-code (or curl -fsSL https://claude.ai/install.sh | bash), then run "claude" once to log in, and run this again.'
  fi
  [ -d "$HOME/.claude" ] || warn 'No ~/.claude folder yet: run "claude" once and log in with your Claude account, then run this again (it installs the skill and the mod there).'
  command -v gh >/dev/null 2>&1 || say 'Optional: the GitHub CLI (brew install gh, then gh auth login) adds PR and merge tracking.'

  # ---------- update: pull when this is a git checkout with an upstream ----------
  # changed: the files the pull (or, after an in-app update, the commits since --from) changed
  changed=''
  if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
    local old=''
    if [ -n "$from" ]; then old=$from
    elif [ "$no_pull" = 0 ] && git -C "$DIR" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
      old=$(git -C "$DIR" rev-parse HEAD)
      # npm install (not npm ci) rewrites desktop/package-lock.json; this script installs from the committed one
      if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no -- desktop/package-lock.json)" ]; then
        git -C "$DIR" checkout -- desktop/package-lock.json
        say 'desktop/package-lock.json was changed here (npm install does that): put back as it was'
      fi
      git -C "$DIR" pull --ff-only --quiet </dev/null || warn 'git pull failed (local changes?); carrying on with what is here.'
    fi
    local new
    new=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)
    if [ -n "$old" ] && [ -n "$new" ] && [ "$old" != "$new" ]; then changed=$(git -C "$DIR" diff --name-only "$old" "$new" 2>/dev/null || true); fi
    if [ -n "$changed" ]; then say "Updated from ${old:0:7} to ${new:0:7} ($(printf '%s\n' "$changed" | grep -c .) files changed)"; fi
  fi

  # ---------- the desktop window (Electron and node-pty in desktop/) ----------
  # relaunch: this run closed the window, so it opens Fleet View again at the end (also when it fails);
  # host_quit: it ended the session host too
  relaunch=0 host_quit=0
  if [ "$no_desktop" = 0 ]; then
    local want have
    want=$(sha256 "$DESK/package-lock.json")
    have=$(cat "$DESK/node_modules/.fleet-view-lock" 2>/dev/null || true)
    if [ "$have" != "$want" ] || [ ! -d "$DESK/node_modules/electron" ]; then
      # npm ci empties node_modules first: never under a running window or session host
      if [ -n "$(fv_pids)" ]; then
        local quit='Fleet View is running, and this update changes its desktop packages, so it has to quit first. Choose "Quit everything" from its menu bar icon (the orange diamond), then run this again.'
        warn 'Fleet View is running, and this update changes its desktop packages, so it has to quit first.'
        warn 'Its window closes and its Claude sessions end; they open again when Fleet View starts (a session mid-turn is told to carry on).'
        ask 'Quit Fleet View now?' || fail "$quit"
        say 'Quitting Fleet View...'
        relaunch=1 host_quit=1
        stop_fleet_view || fail "$quit"
      fi
      if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
        warn "Apple's command line tools are not installed. If node-pty has no ready-made build for this Mac it has to compile, which needs them: xcode-select --install"
      fi
      say 'Installing the desktop window (Electron, about 100 MB, a minute or two)...'
      if ! (cd "$DESK" && npm ci --no-audit --no-fund --loglevel=error </dev/null); then
        if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
          fail 'npm ci in desktop/ failed (see above), most likely because node-pty had to compile: run xcode-select --install, then run this again. Or add --no-desktop to use a Chrome or Edge window.'
        fi
        fail 'npm ci in desktop/ failed (see above). Run this again, or add --no-desktop to use a Chrome or Edge window.'
      fi
      printf '%s\n' "$want" > "$DESK/node_modules/.fleet-view-lock"
    fi
    # some npm setups skip electron's postinstall, which downloads Electron: fetch it here then
    if [ ! -e "$(electron_bin)" ]; then
      say 'Downloading Electron...'
      node "$DESK/node_modules/electron/install.js" </dev/null || warn 'Electron could not be downloaded; Fleet View opens in a Chrome or Edge window until this runs again.'
    fi
    # node-pty starts each session through spawn-helper, which must keep its execute bit
    find "$DESK/node_modules/node-pty" -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true
    if [ -e "$(electron_bin)" ] && ! ELECTRON_RUN_AS_NODE=1 "$(electron_bin)" -e 'require(process.argv[1])' "$DESK/node_modules/node-pty" </dev/null >/dev/null 2>&1; then
      warn 'node-pty does not load in Electron here, so live sessions in the panel are off. Run this again; if it stays, xcode-select --install and run it once more.'
    fi
    say 'Desktop window ready'

    # ---------- Fleet View.app ----------
    if [ "$OS" = Darwin ] && [ -e "$(electron_bin)" ]; then
      if ! bash "$DIR/scripts/mac-app.sh" --check; then
        # a new bundle under a running window: close the window first (the sessions stay in the host)
        if [ "$relaunch" = 0 ] && [ -n "$(fv_pids window)" ]; then
          say 'Closing the Fleet View window for the new app (the sessions keep running)...'
          if stop_window; then relaunch=1; else warn 'The Fleet View window did not close; quit it (Cmd+Q) and open Fleet View again to load the update.'; fi
        fi
        bash "$DIR/scripts/mac-app.sh" || fail 'Fleet View.app could not be built (see above).'
      else
        say "Fleet View.app is up to date ($APP)"
      fi
    fi
  fi

  # ---------- a running Fleet View takes in what the pull changed (as "Update now" does) ----------
  # fleet-view.js and web/ reload by themselves; a changed host.js or handoff.js restarts the session host once no
  # session is mid-turn (it resumes them); any other change in desktop/ restarts the window (the sessions stay)
  if [ -n "$changed" ] && [ -n "$(fv_pids)" ]; then
    if [ "$host_quit" = 0 ] && printf '%s\n' "$changed" | grep -Eq '^(desktop/host\.js|handoff\.js)$'; then
      node "$DESK/restart-host.js" </dev/null 2>&1 | sed 's/^/  /' || true
    fi
    if [ "$relaunch" = 0 ] && [ -n "$(fv_pids window)" ] && printf '%s\n' "$changed" | grep -E '^desktop/' | grep -vEq '^desktop/host\.js$'; then
      if stop_window; then say 'Restarting the Fleet View window (the sessions keep running)...'; relaunch=1
      else warn 'The Fleet View window did not close; quit it (Cmd+Q) and open Fleet View again to load the update.'; fi
    fi
  fi

  # ---------- fleet-view and fv on PATH (~/.local/bin) ----------
  local bin="$HOME/.local/bin"
  mkdir -p "$bin"
  link_cmd fleet-view "$DIR/fleet-view.sh" bash
  link_cmd fv "$DIR/fv" sh
  # ~/.zprofile on macOS (~/.profile on Linux) always; the other profiles only when there is one already
  local added=0 f first=.profile
  [ "$OS" = Darwin ] && first=.zprofile
  for f in "$first" .zprofile .bash_profile; do
    if [ "$f" != "$first" ] && [ ! -f "$HOME/$f" ]; then continue; fi
    if add_path_line "$HOME/$f"; then added=1; fi
  done
  if [ "$added" = 1 ]; then say 'Added ~/.local/bin to your PATH: fleet-view and fv work in any new terminal window'
  else say 'fleet-view and fv are in ~/.local/bin'; fi

  # ---------- the fleet-view skill, so Claude Code sessions know the fv command ----------
  # into each Claude login there is (~/.claude and every ~/.claude-<letter>); replaced on every run, and refreshed by
  # the in-app update too
  local skill="$DIR/skills/fleet-view/SKILL.md" login name
  if [ -f "$skill" ]; then
    for login in "$HOME/.claude" "$HOME"/.claude-[a-z]; do
      [ -d "$login" ] || continue
      name=$(basename "$login")
      # a skills/fleet-view that is a link (to this folder's skill, say) is left as it is: copying would copy onto itself
      if [ -L "$login/skills/fleet-view" ]; then say "Skill fleet-view in ~/$name is a link; left as it is"; continue; fi
      if mkdir -p "$login/skills/fleet-view" && cp "$skill" "$login/skills/fleet-view/SKILL.md"; then say "Skill fleet-view installed in ~/$name"
      else warn "Could not install the skill fleet-view in ~/$name"; fi
    done
  fi

  # ---------- the fleet-view-feed mod: each claude tells Fleet View when a turn starts and ends and what runs ----------
  # The mod folder is a directory marketplace. Claude copies the mod into each login at install and records its
  # version; a Claude that runs that copy misses a git pull, so where the mod is already installed this updates it
  # (as Fleet View's server does at each start, feed-mod.js, when the version moves). New sessions load the new one.
  if [ -f "$DIR/mod/.claude-plugin/marketplace.json" ] && command -v claude >/dev/null 2>&1; then
    for login in "$HOME/.claude" "$HOME"/.claude-[a-z]; do
      [ -d "$login" ] || continue
      name=$(basename "$login")
      local cfg=''
      [ "$name" = .claude ] || cfg=$login
      local known
      known=$(in_login "$cfg" claude plugin marketplace list 2>/dev/null || true)
      case $known in
        *fleet-view*) ;;
        *) in_login "$cfg" claude plugin marketplace add "$DIR/mod" >/dev/null 2>&1 || true ;;
      esac
      # update fails when it is not installed in this login yet: then it is installed
      in_login "$cfg" claude plugin marketplace update fleet-view >/dev/null 2>&1 || true
      if in_login "$cfg" claude plugin update fleet-view-feed@fleet-view --scope user >/dev/null 2>&1; then say "Live feed mod up to date in ~/$name"
      elif in_login "$cfg" claude plugin install fleet-view-feed@fleet-view --scope user >/dev/null 2>&1; then say "Live feed mod installed in ~/$name"
      else warn "Could not install the live feed mod in ~/$name (claude plugin install fleet-view-feed@fleet-view); Fleet View works without it."; fi
    done
  fi

  # ---------- open at login ----------
  if [ "$remove_login" = 1 ]; then
    if [ "$OS" = Darwin ]; then bash "$DIR/scripts/mac-app.sh" --remove-start-at-login; else warn '--remove-start-at-login is for macOS.'; fi
  elif [ "$start_login" = 1 ]; then
    if [ "$OS" = Darwin ] && [ -d "$APP" ]; then bash "$DIR/scripts/mac-app.sh" --start-at-login
    else warn '--start-at-login needs Fleet View.app (macOS, without --no-desktop).'; fi
  fi

  # the version now here (version.js: 1.0.12), so "which version are you on" has an answer
  local ver
  ver=$(node "$DIR/version.js" 2>/dev/null || true)
  [ -n "$ver" ] && say "Fleet View $ver"

  # a Fleet View this script quit or closed opens again, --no-launch or not
  if [ "$no_launch" = 0 ] || [ "$relaunch" = 1 ]; then
    say 'Starting Fleet View...'
    start_fleet_view
  fi
  if [ "$OS" = Darwin ] && [ -d "$APP" ] && [ "$no_desktop" = 0 ]; then
    printf '\n%s  Done. Next time: open Fleet View from Applications (or Spotlight), or type fleet-view in a new terminal.\n  Update later: Update now in Fleet View, or run this script again (it pulls and reinstalls only what changed).%s\n\n' "$GREEN" "$RESET"
  else
    printf '\n%s  Done. Next time: type fleet-view in a new terminal.\n  Update later: Update now in Fleet View, or run this script again (it pulls and reinstalls only what changed).%s\n\n' "$GREEN" "$RESET"
  fi
}

# ---------- helpers ----------
if [ -t 1 ]; then CYAN=$'\033[36m' YELLOW=$'\033[33m' RED=$'\033[31m' GREEN=$'\033[32m' RESET=$'\033[0m'
else CYAN='' YELLOW='' RED='' GREEN='' RESET=''; fi
say() { printf '  %s\n' "$*"; }
warn() { printf '%s  %s%s\n' "$YELLOW" "$*" "$RESET"; }
# a Fleet View this run quit opens again even when the run stops early
fail() {
  printf '%s  %s%s\n' "$RED" "$*" "$RESET" >&2
  if [ "${relaunch:-0}" = 1 ]; then printf '  Opening Fleet View again as it is.\n' >&2; start_fleet_view || true; fi
  exit 1
}

start_fleet_view() {
  if [ "$OS" = Darwin ] && [ -d "$APP" ] && [ "${no_desktop:-0}" = 0 ]; then open "$APP"
  else nohup bash "$DIR/fleet-view.sh" </dev/null >/dev/null 2>&1 &
  fi
}

need_git() {
  if [ "$OS" = Darwin ] && [ "$(command -v git 2>/dev/null)" = /usr/bin/git ] && ! xcode-select -p >/dev/null 2>&1; then
    fail "git needs Apple's command line tools: run xcode-select --install (or brew install git), then run this again."
  fi
  git --version >/dev/null 2>&1 || fail 'git is missing. Install it (xcode-select --install, or brew install git) and run this again.'
}

need_node() {
  command -v node >/dev/null 2>&1 || fail 'Node.js is missing. Install Node 18 or newer (brew install node, or the installer from https://nodejs.org), open a new terminal window and run this again.'
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 18 ] 2>/dev/null || fail "Node $major is too old: Fleet View needs 18 or newer (brew upgrade node, or https://nodejs.org)."
  say "Node $(node -v)"
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# the Electron binary npm ci put in desktop/
electron_bin() {
  if [ "$OS" = Darwin ]; then printf '%s' "$DESK/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  else printf '%s' "$DESK/node_modules/electron/dist/electron"; fi
}

# The pids of Fleet View's processes that run this checkout's Electron or Fleet View.app: the window, the server it
# started and the session host. "window": the window alone. The paths go to awk through its environment, so its
# own command line never matches.
fv_pids() {
  ps -A -o pid=,command= 2>/dev/null | FV_A="$DESK/node_modules/electron/dist/" FV_B="$APP/Contents/" FV_W=${1:-} awk '
    {
      line = $0
      sub(/^ *[0-9]+ +/, "", line)
      if (index(line, ENVIRON["FV_A"]) != 1 && index(line, ENVIRON["FV_B"]) != 1) next
      if (ENVIRON["FV_W"] == "window" && (line ~ /\/Frameworks\// || index(line, "fleet-view.js") || index(line, "host.js"))) next
      print $1
    }' || true
}

# waits up to $2 seconds until fv_pids $1 is empty
wait_gone() {
  local i=0
  while [ "$i" -lt "$2" ]; do
    [ -z "$(fv_pids "$1")" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  [ -z "$(fv_pids "$1")" ]
}

# Closes the window the way Cmd+Q does: Electron takes SIGTERM as a quit, and the server it started stops with it.
# The session host and its sessions keep running. True when it went.
stop_window() {
  local p
  for p in $(fv_pids window); do kill -TERM "$p" 2>/dev/null || true; done
  wait_gone window 20
}

# Quits Fleet View the way its "Quit everything" does: the window closes, then the session host saves the restore
# list, ends every session and exits (desktop/quit-all.js). True once nothing runs from Electron here.
stop_fleet_view() {
  stop_window || return 1
  node "$DESK/quit-all.js" </dev/null 2>&1 | sed 's/^/  /' || true
  wait_gone '' 20
}

# asks a yes/no question on the terminal (also when this script came through a pipe); --yes answers yes
ask() {
  local answer=''
  [ "$yes" = 1 ] && return 0
  ( : </dev/tty ) 2>/dev/null || return 1
  printf '%s  %s [y/N] %s' "$YELLOW" "$1" "$RESET" >/dev/tty
  read -r answer </dev/tty || answer=''
  case $answer in [yY]*) return 0 ;; esac
  return 1
}

# ~/.local/bin/<name> -> the script here. A script without its execute bit (a copy made without it) gets a small
# script that runs it with $3 instead, so the clone itself is never changed (git would call that a local change)
link_cmd() {
  local to="$HOME/.local/bin/$1"
  if [ -e "$to" ] && [ ! -L "$to" ] && ! grep -q 'Fleet View' "$to" 2>/dev/null; then warn "$to is there and is not Fleet View's; left as it is"; return 0; fi
  rm -f "$to"
  if [ -x "$2" ]; then ln -s "$2" "$to"
  else
    printf '#!/bin/sh\n# Fleet View: %s\nexec %s "%s" "$@"\n' "$1" "$3" "$2" > "$to"
    chmod +x "$to"
  fi
}

# adds the ~/.local/bin PATH line to a shell profile once (the "# Fleet View" line marks it). True when added
add_path_line() {
  if [ -f "$1" ] && grep -q '^# Fleet View' "$1"; then return 1; fi
  printf '\n# Fleet View\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$1"
}

# runs a command in a Claude login ('' = ~/.claude, else that folder as CLAUDE_CONFIG_DIR), 60 s at most
in_login() {
  local cfg=$1
  shift
  (
    if [ -n "$cfg" ]; then export CLAUDE_CONFIG_DIR="$cfg"; else unset CLAUDE_CONFIG_DIR; fi
    "$@" </dev/null &
    local p=$! rc=0
    # the watchdog ends with the command, or ends it after 60 s
    (
      i=0
      while [ "$i" -lt 60 ] && kill -0 "$p" 2>/dev/null; do sleep 1; i=$((i + 1)); done
      kill "$p" 2>/dev/null || true
    ) >/dev/null 2>&1 &
    wait "$p" || rc=$?
    exit "$rc"
  )
}

# the whole script is read before any of it runs (main is called on the last line), so a curl | bash whose
# commands read stdin can't eat the rest of it
main ${1+"$@"}
