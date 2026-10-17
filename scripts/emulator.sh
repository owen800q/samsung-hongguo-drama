#!/usr/bin/env bash
# Build, sign, install and launch the app in the Samsung TV emulator.
# Usage: scripts/emulator.sh <samsung-security-profile> [vm-name]
# Needs Tizen Studio (~/tizen-studio) with TV-SAMSUNG-Public-Emulator, a Samsung TV
# certificate profile whose distributor certificate lists the emulator's DUID (plain
# Tizen certificates are rejected), and on macOS Intel HAXM loaded (reboot after installing).
set -euo pipefail
PROFILE="${1:?usage: scripts/emulator.sh <samsung-security-profile> [vm-name]}"
VM="${2:-hgtv}"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
export PATH="$TIZEN_HOME/tools/ide/bin:$TIZEN_HOME/tools:$TIZEN_HOME/tools/emulator/bin:$PATH"
APP_ID="HgDrama001.HongguoTV"
cd "$(dirname "$0")/.."

if ! em-cli list-vm | grep -qx "$VM"; then
  em-cli create -n "$VM" -p tv-samsung-10.0-x86_64 -t "HD1080 TV"
fi
if ! sdb devices | grep -q "emulator.*device"; then
  em-cli launch -n "$VM"
  echo "Waiting for the emulator to boot…"
  until sdb devices | grep -q "emulator.*device"; do sleep 3; done
fi
DEVICE="$(sdb devices | awk '/emulator.*device/{print $1; exit}')"

npm run build
npm run package -- --profile "$PROFILE"
WGT="build/HongguoTV.wgt"
# sdb lists the device before the guest finishes booting (and TV images refuse
# `sdb shell`), so retry the install for a while.
for attempt in $(seq 1 20); do
  if tizen install -s "$DEVICE" -n "$WGT" | tee /dev/stderr | grep -q "successfully"; then break; fi
  [ "$attempt" = 20 ] && { echo "Install failed" >&2; exit 1; }
  sleep 10
done
tizen run -s "$DEVICE" -p "$APP_ID"
echo "Running on $DEVICE. Web inspector: sdb -s $DEVICE shell 0 debug $APP_ID"
