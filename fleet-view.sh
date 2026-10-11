#!/usr/bin/env bash
# Fleet View on macOS and Linux: the "fleet-view" command (install.sh links it into ~/.local/bin), the counterpart of
# fleet-view.cmd on Windows.
#   fleet-view                  opens Fleet View.app when it is installed (macOS); else runs the server here, in a
#                               loop, and opens the app window (the desktop window from desktop/ once installed,
#                               else Chrome or Edge in app mode)
#   fleet-view --tui            the terminal view, in this terminal
#   fleet-view --port 4800 ...  any other option: the server loop with those options (node fleet-view.js --help)
# The loop: fleet-view.js exits with 75 when its file changes (an update); it starts again at once, with --no-open,
# so the open window just reconnects. Any other non-zero exit is a crash (76 is an uncaught exception; server.log
# says what happened): it starts again after 3 s, also with --no-open, and gives up after 5 crashes within 2
# minutes. Exit 0 (Ctrl+C, or another Fleet View already serving) ends the loop.
set -u

# this script's folder, through the link in ~/.local/bin
f=${BASH_SOURCE[0]}
while [ -L "$f" ]; do
  l=$(readlink "$f")
  case $l in /*) f=$l ;; *) f=$(dirname "$f")/$l ;; esac
done
DIR=$(cd "$(dirname "$f")" && pwd -P)
APP=${FLEET_VIEW_APP:-"$HOME/Applications/Fleet View.app"}
if [ "$(uname -s)" = Darwin ]; then DATA="$HOME/Library/Application Support/fleet-view"; else DATA="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-view"; fi
case $DATA in /*) ;; *) DATA="$HOME/.local/state/fleet-view" ;; esac
LOG="$DATA/server.log"

command -v node >/dev/null 2>&1 || { echo 'Fleet View needs Node.js 18 or newer, and node was not found (brew install node, or https://nodejs.org).' >&2; exit 1; }

# ---------- the terminal view, and the one-off commands: in this terminal ----------
tui=0
for a in "$@"; do
  case $a in --tui|--snapshot|--help|-h|--version|--install-startup|--remove-startup) tui=1 ;; esac
done
if [ "$tui" = 1 ]; then
  # fleet-view.js exits with 75 when its file changes; start it again in the same terminal
  export FLEET_VIEW_LOOP=1
  no_open=''
  while :; do
    node "$DIR/fleet-view.js" $no_open "$@"
    code=$?
    [ "$code" = 75 ] || exit "$code"
    no_open=--no-open
  done
fi

# ---------- the app, when it is installed and nothing else was asked for ----------
if [ $# -eq 0 ] && [ "$(uname -s)" = Darwin ] && [ -d "$APP" ]; then
  exec open "$APP"
fi

# ---------- web: the server loop ----------
log() {
  mkdir -p "$DATA" 2>/dev/null
  printf '%s [fleet-view.sh] %s\n' "$(date '+%Y-%m-%d %H:%M:%S.000')" "$1" >> "$LOG" 2>/dev/null
}
export FLEET_VIEW_LOOP=1
no_open=''
unset FV_RESTART_REASON
# Ctrl+C reaches node too, which stops with code 0; the loop ends then whatever code it gives
stop=0
trap 'stop=1' INT TERM HUP
c1='' c2='' c3='' c4='' c5=''
while :; do
  node "$DIR/fleet-view.js" --web $no_open "$@"
  code=$?
  [ "$stop" = 1 ] && exit 0
  [ "$code" = 0 ] && exit 0
  no_open=--no-open
  if [ "$code" = 75 ]; then
    export FV_RESTART_REASON='an update (exit 75)'
    continue
  fi
  # the times of the last five crashes, oldest first
  now=$(date +%s)
  c1=$c2 c2=$c3 c3=$c4 c4=$c5 c5=$now
  if [ -n "$c1" ] && [ $((now - c1)) -le 120 ]; then
    log "gave up: 5 crashes within 2 minutes, the last with exit code $code; run fleet-view again to start it"
    echo "Fleet View crashed 5 times within 2 minutes and was not started again. See $LOG" >&2
    exit "$code"
  fi
  export FV_RESTART_REASON="a crash (exit $code)"
  log "node exited with code $code (crash): starting it again in 3 s with --no-open"
  echo "Fleet View stopped with exit code $code; starting it again in 3 s. Log: $LOG" >&2
  sleep 3
  [ "$stop" = 1 ] && exit 0
done
