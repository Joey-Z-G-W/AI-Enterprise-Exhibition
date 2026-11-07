#!/usr/bin/env bash
# Install a fixed, reviewed controller outside the checkout. Never install PR code.
set -euo pipefail
cd "$(dirname "$0")/.."
controller_dir="${COURSE_CONTROLLER_DIR:-$HOME/.local/share/exhibition-course-controller}"
state_dir="${COURSE_STATE_DIR:-$HOME/.local/state/exhibition-course}"
case "${1:-help}" in
  install)
    mkdir -p "$controller_dir" "$state_dir"
    cp tools/course_deploy.py "$controller_dir/course_deploy.py"
    printf '%s\n' "Installed controller: $controller_dir/course_deploy.py" "State: $state_dir"
    ;;
  start)
    test -f "$controller_dir/course_deploy.py"
    if [[ -f "$state_dir/controller.pid" ]] && kill -0 "$(cat "$state_dir/controller.pid")" 2>/dev/null; then
      echo 'Controller is already running'; exit 1
    fi
    gh auth status >/dev/null 2>&1
    docker info >/dev/null
    nohup python3 -u "$controller_dir/course_deploy.py" --state-dir "$state_dir" watch >"$state_dir/controller.log" 2>&1 </dev/null &
    echo "$!" > "$state_dir/controller.pid"
    echo "Started controller PID $! (log: $state_dir/controller.log)"
    ;;
  stop)
    if [[ -f "$state_dir/controller.pid" ]]; then
      controller_pid="$(cat "$state_dir/controller.pid")"
      if [[ -r "/proc/$controller_pid/cmdline" ]] && tr '\0' ' ' < "/proc/$controller_pid/cmdline" | grep -Fq "$controller_dir/course_deploy.py"; then
        kill "$controller_pid"
      fi
      rm "$state_dir/controller.pid"
    fi
    ;;
  status)
    python3 "$controller_dir/course_deploy.py" --state-dir "$state_dir" status
    ;;
  *) echo 'Usage: tools/course_runner.sh {install|start|stop|status}';;
esac
