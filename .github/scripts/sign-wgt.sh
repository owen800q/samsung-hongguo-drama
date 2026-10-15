#!/usr/bin/env bash
# Sign a staged Tizen widget with the Samsung certificate profile kept in repository
# secrets. Installs Samsung's Tizen CLI from download.tizen.org when it is missing.
# Usage: sign-wgt.sh <widget-dir> <output.wgt>
# Environment: TIZEN_AUTHOR_P12 and TIZEN_DISTRIBUTOR_P12 (the .p12 files, base64)
# and TIZEN_AUTHOR_PASSWORD and TIZEN_DISTRIBUTOR_PASSWORD.
set -euo pipefail
STAGE="$(cd "$1" && pwd)"
OUT="$2"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
TIZEN="$TIZEN_HOME/tools/ide/bin/tizen"
CLI_URL="https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin"

if [ ! -x "$TIZEN" ]; then
  installer="$(mktemp)"
  curl -fsSL -o "$installer" "$CLI_URL"
  chmod +x "$installer"
  echo y | "$installer" --accept-license "$TIZEN_HOME" > /dev/null
  rm -f "$installer"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf '%s' "$TIZEN_AUTHOR_P12" | base64 -d > "$WORK/author.p12"
printf '%s' "$TIZEN_DISTRIBUTOR_P12" | base64 -d > "$WORK/distributor.p12"
# Without a desktop keyring `tizen security-profiles add` cannot store the passwords,
# so the profile is written with them in place, which the CLI accepts.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
cat > "$WORK/profiles.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="ci" version="3.1">
<profile name="ci">
<profileitem ca="" distributor="0" key="$WORK/author.p12" password="$(xml "$TIZEN_AUTHOR_PASSWORD")" rootca=""/>
<profileitem ca="" distributor="1" key="$WORK/distributor.p12" password="$(xml "$TIZEN_DISTRIBUTOR_PASSWORD")" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>
</profiles>
EOF
"$TIZEN" cli-config "default.profiles.path=$WORK/profiles.xml" > /dev/null
mkdir "$WORK/out"
"$TIZEN" package -t wgt -s ci -o "$WORK/out" -- "$STAGE"
# The CLI reports some failures with exit code 0: check that a widget came out.
BUILT="$(find "$WORK/out" -name '*.wgt' | head -1)"
[ -n "$BUILT" ] || { echo "Signing failed: no widget produced (see ~/tizen-studio-data/cli/logs/cli.log)." >&2; exit 1; }
mv "$BUILT" "$OUT"
# Drop the signature files the CLI leaves in the staged widget.
rm -f "$STAGE/author-signature.xml" "$STAGE/signature1.xml"
echo "Signed widget: $OUT"
