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
# Without a desktop keyring `tizen security-profiles add` cannot store the passwords.
# The CLI also reads a password written into the profile, but only in the form its
# own CipherUtil encrypts (a plain one makes it prompt, which fails without a terminal),
# so encrypt them with that class from the CLI's jars.
cat > "$WORK/Encrypt.java" <<'EOF'
public class Encrypt {
  public static void main(String[] a) throws Exception {
    java.nio.file.Files.writeString(java.nio.file.Path.of(a[1]), org.tizen.common.util.CipherUtil.getEncryptedString(System.getenv(a[0])));
  }
}
EOF
encrypt() {
  java --add-exports java.xml/com.sun.org.apache.xerces.internal.impl.dv.util=ALL-UNNAMED \
    -cp "$TIZEN_HOME/tools/ide/lib-ncli/*" "$WORK/Encrypt.java" "$1" "$WORK/$1" > /dev/null 2>&1
  cat "$WORK/$1"
}
AUTHOR_PW="$(encrypt TIZEN_AUTHOR_PASSWORD)"
DISTRIBUTOR_PW="$(encrypt TIZEN_DISTRIBUTOR_PASSWORD)"
[ -n "$AUTHOR_PW" ] && [ -n "$DISTRIBUTOR_PW" ] || { echo "Could not encrypt the certificate passwords." >&2; exit 1; }
cat > "$WORK/profiles.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="ci" version="3.1">
<profile name="ci">
<profileitem ca="" distributor="0" key="$WORK/author.p12" password="$AUTHOR_PW" rootca=""/>
<profileitem ca="" distributor="1" key="$WORK/distributor.p12" password="$DISTRIBUTOR_PW" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>
</profiles>
EOF
"$TIZEN" cli-config "default.profiles.path=$WORK/profiles.xml" > /dev/null
mkdir "$WORK/out"
"$TIZEN" package -t wgt -s ci -o "$WORK/out" -- "$STAGE"
# The CLI reports some failures with exit code 0, and can write a widget without
# signing it: check that a signed widget came out.
BUILT="$(find "$WORK/out" -name '*.wgt' | head -1)"
[ -n "$BUILT" ] && unzip -l "$BUILT" | grep -q 'author-signature\.xml' \
  || { echo "Signing failed: no signed widget produced (see ~/tizen-studio-data/cli/logs/cli.log)." >&2; exit 1; }
mv "$BUILT" "$OUT"
# Drop the signature files the CLI leaves in the staged widget.
rm -f "$STAGE/author-signature.xml" "$STAGE/signature1.xml"
echo "Signed widget: $OUT"
