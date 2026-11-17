#!/usr/bin/env bash
# 无 Gradle 构建：aapt2 + javac + dx + zipalign + apksigner
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
APP_DIR="$ROOT/android"
SDK_ROOT="${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-$SDK_ROOT/build-tools/29.0.3}"
PLATFORM_JAR="${ANDROID_JAR:-$SDK_ROOT/platforms/android-23/android.jar}"
AAPT2="$BUILD_TOOLS/aapt2"
DX="$BUILD_TOOLS/dx"
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="${APKSIGNER:-$(command -v apksigner || true)}"
KEY_DIR="${GOAPP_KEY_DIR:-$ROOT/.android-keys}"
KEYSTORE="$KEY_DIR/goapp-release.jks"
KEY_ALIAS="goapp"

for file in "$AAPT2" "$DX" "$PLATFORM_JAR"; do
  [[ -e "$file" ]] || {
    printf '缺少 Android 构建组件：%s\n' "$file" >&2
    exit 1
  }
done
[[ -n "$ZIPALIGN" && -x "$ZIPALIGN" ]] || {
  printf '缺少 zipalign：%s\n' "$ZIPALIGN" >&2
  exit 1
}
[[ -n "$APKSIGNER" && -x "$APKSIGNER" ]] || {
  printf '缺少 apksigner；可设置 APKSIGNER 环境变量\n' >&2
  exit 1
}

APP_VERSION=$(sed -n "s/^const APP_VER = '\([^']*\)';/\1/p" "$ROOT/prototype/app.js")
[[ -n "$APP_VERSION" ]] || {
  printf '无法从 prototype/app.js 读取 APP_VER\n' >&2
  exit 1
}
VERSION_CODE=$(awk -F. '{printf "%d%02d%02d", $1, $2, $3}' <<< "$APP_VERSION")

configured_domain=""
if [[ -f "$ROOT/.env" ]]; then
  configured_domain=$(sed -n 's/^DOMAIN=//p' "$ROOT/.env" | head -1)
fi
DEFAULT_APP_URL="https://locale-homework-indicating-sam.trycloudflare.com/"
if [[ -n "$configured_domain" ]]; then
  DEFAULT_APP_URL="https://$configured_domain/"
fi
APP_URL="${APP_URL:-$DEFAULT_APP_URL}"
[[ "$APP_URL" =~ ^https://[^[:space:]]+/$ ]] || {
  printf 'APP_URL 必须是以 / 结尾的 HTTPS 地址：%s\n' "$APP_URL" >&2
  exit 1
}
APP_URL="$APP_URL?native=1"

OUT_DIR="$ROOT/dist"
OUTPUT="$OUT_DIR/goapp-v$APP_VERSION.apk"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR" "$WORK/gen" "$WORK/classes" "$KEY_DIR"

printf '→ 编译 Android 资源\n'
"$AAPT2" compile --dir "$APP_DIR/res" -o "$WORK/resources.zip"
"$AAPT2" link \
  -o "$WORK/base.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$APP_DIR/AndroidManifest.xml" \
  --java "$WORK/gen" \
  --min-sdk-version 23 \
  --target-sdk-version 29 \
  --version-code "$VERSION_CODE" \
  --version-name "$APP_VERSION" \
  "$WORK/resources.zip"

printf '→ 编译 Java\n'
sed "s|__APP_URL__|$APP_URL|g" \
  "$APP_DIR/src/com/goapp/trip/AppConfig.java.in" \
  > "$WORK/gen/com/goapp/trip/AppConfig.java"
mapfile -t JAVA_FILES < <(find "$WORK/gen" "$APP_DIR/src" -name '*.java' -type f)
javac -source 8 -target 8 -Xlint:-options \
  -bootclasspath "$PLATFORM_JAR" \
  -d "$WORK/classes" \
  "${JAVA_FILES[@]}"

printf '→ 生成 classes.dex\n'
"$DX" --dex --output="$WORK/classes.dex" "$WORK/classes"
cp "$WORK/base.apk" "$WORK/unsigned.apk"
(cd "$WORK" && zip -q -j unsigned.apk classes.dex)

printf '→ 对齐与签名\n'
"$ZIPALIGN" -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
if [[ ! -f "$KEYSTORE" ]]; then
  PASSWORD_FILE="$KEY_DIR/password"
  if [[ ! -f "$PASSWORD_FILE" ]]; then
    openssl rand -hex 24 > "$PASSWORD_FILE"
    chmod 600 "$PASSWORD_FILE"
  fi
  PASSWORD=$(<"$PASSWORD_FILE")
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass "$PASSWORD" \
    -keypass "$PASSWORD" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Goapp, OU=Mobile, O=Goapp, L=Shanghai, ST=Shanghai, C=CN" \
    >/dev/null
fi
PASSWORD_FILE="$KEY_DIR/password"
[[ -f "$PASSWORD_FILE" ]] || {
  printf '缺少签名密码文件 %s\n' "$PASSWORD_FILE" >&2
  exit 1
}
PASSWORD=$(<"$PASSWORD_FILE")
"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$PASSWORD" \
  --key-pass "pass:$PASSWORD" \
  --min-sdk-version 23 \
  --out "$OUTPUT" \
  "$WORK/aligned.apk"

"$APKSIGNER" verify --verbose --min-sdk-version 23 "$OUTPUT" >/dev/null
sha256sum "$OUTPUT" > "$OUTPUT.sha256"
printf '\n✓ APK：%s\n' "$OUTPUT"
printf '✓ SHA-256：%s\n' "$(cut -d' ' -f1 "$OUTPUT.sha256")"
