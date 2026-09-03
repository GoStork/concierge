#!/bin/bash
# Install/refresh the local nightly-sync timer on the production VM.
# Run ON the VM from the repo checkout:  sudo bash /srv/gostork/app/ops/prod/install-nightly-timer.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
install -m 755 "$DIR/gostork-nightly-ping" /usr/local/bin/gostork-nightly-ping
install -m 644 "$DIR/gostork-nightly.service" /etc/systemd/system/gostork-nightly.service
install -m 644 "$DIR/gostork-nightly.timer" /etc/systemd/system/gostork-nightly.timer
systemctl daemon-reload
systemctl enable --now gostork-nightly.timer
systemctl list-timers --no-pager | grep gostork-nightly
