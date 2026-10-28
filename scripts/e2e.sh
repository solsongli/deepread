#!/usr/bin/env bash
# Run an end-to-end test script inside an isolated, headless Zotero instance.
#   scripts/e2e.sh test/e2e/basic.js            (fake MinerU + fake LLM, offline)
# The test profile/data dir live in .test-profile/ (git-ignored); the user's real Zotero
# profile and data directory are never used.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$(realpath "${1:-$REPO/test/e2e/basic.js}")"
ZOTERO="${ZOTERO_BIN:-$HOME/.local/opt/zotero-10.0.6/zotero}"
BASE="$REPO/.test-profile"
PROFILE="$BASE/profile"
DATA="$BASE/data"
OUT="$BASE/result.json"
LOG="$BASE/zotero.log"
TIMEOUT="${E2E_TIMEOUT:-300}"

mkdir -p "$PROFILE/extensions" "$DATA" "$BASE/shots"
# Sideload freshly built XPIs (Gecko 140 no longer honours developer proxy files).
rm -f "$PROFILE/extensions/deepread@lsy-aia.github.io" "$PROFILE/extensions/deepread-e2e@lsy-aia.github.io"
rm -f "$PROFILE/extensions/"*.xpi
if [ -n "${E2E_BASE_XPI:-}" ]; then
  # Start from a released build (used to test in-place upgrades, see test/e2e/upgrade.js).
  cp "$E2E_BASE_XPI" "$PROFILE/extensions/deepread@lsy-aia.github.io.xpi"
elif [ -n "${E2E_ADDON_VERSION:-}" ]; then
  # Install the add-on under a different version (used to test self-updating).
  TMP_ADDON="$BASE/addon-versioned"; rm -rf "$TMP_ADDON"; cp -r "$REPO/addon" "$TMP_ADDON"
  sed -i "s/\"version\": \"[0-9.]*\"/\"version\": \"$E2E_ADDON_VERSION\"/" "$TMP_ADDON/manifest.json"
  (cd "$TMP_ADDON" && zip -r -X -q "$PROFILE/extensions/deepread@lsy-aia.github.io.xpi" . -x "*.DS_Store")
else
  (cd "$REPO/addon" && zip -r -X -q "$PROFILE/extensions/deepread@lsy-aia.github.io.xpi" . -x "*.DS_Store")
fi
(cd "$REPO/test/dev-harness" && zip -r -X -q "$PROFILE/extensions/deepread-e2e@lsy-aia.github.io.xpi" .)

cat > "$PROFILE/user.js" <<EOF
user_pref("extensions.zotero.dataDir", "$DATA");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.port", 23129);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.debug.time", false);
user_pref("extensions.logging.enabled", true);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("extensions.zotero.deepread.llm.baseURL", "${E2E_LLM_URL:-http://127.0.0.1:18766/v1}");
user_pref("extensions.zotero.deepread.llm.apiKey", "test-key");
user_pref("extensions.zotero.deepread.llm.model", "${E2E_LLM_MODEL:-fake}");
user_pref("extensions.zotero.deepread.llm.jsonMode", "${E2E_JSON_MODE:-json_object}");
user_pref("extensions.zotero.deepread.parser.provider", "${E2E_PARSER:-selfhost}");
user_pref("extensions.zotero.deepread.parser.selfHostURL", "http://127.0.0.1:18765");
user_pref("extensions.zotero.deepread.parser.mineruBaseURL", "http://127.0.0.1:18765");
user_pref("extensions.zotero.deepread.parser.mineruToken", "test-token");
user_pref("extensions.zotero.deepread.language", "${E2E_LANG:-zh}");
user_pref("extensions.zotero.deepread.debug", ${E2E_DEBUG:-false});
EOF
# Force the add-on manager to rescan proxy files on startup.
[ -f "$PROFILE/prefs.js" ] && sed -i '/extensions.lastAppBuildId/d;/extensions.lastAppVersion/d' "$PROFILE/prefs.js"

# Fake services (started once, reused).
if [ "${E2E_SKIP_SERVICES:-0}" != "1" ]; then
if ! curl -s -o /dev/null "http://127.0.0.1:18765/docs"; then
  [ -f "$REPO/test/fixtures/demo/mineru-result.zip" ] || python3 "$REPO/test/build-fixture.py"
  nohup node "$REPO/test/fake-mineru.mjs" --port 18765 > "$BASE/fake-mineru.log" 2>&1 &
fi
if ! curl -s -o /dev/null "http://127.0.0.1:18766/v1/models"; then
  nohup node "$REPO/test/fake-openai.mjs" --port 18766 ${FAKE_OPENAI_ARGS:-} > "$BASE/fake-openai.log" 2>&1 &
fi
sleep 0.5
fi

rm -f "$OUT"
export DEEPREAD_E2E_SCRIPT="$SCRIPT" DEEPREAD_E2E_OUT="$OUT" DEEPREAD_E2E_QUIT="${E2E_QUIT:-1}"
export DEEPREAD_E2E_PDF="${E2E_PDF:-$REPO/test/fixtures/demo/demo-paper.pdf}"
export DEEPREAD_E2E_SHOTS="$BASE/shots"
export MOZ_HEADLESS="${MOZ_HEADLESS:-1}" MOZ_HEADLESS_WIDTH=1600 MOZ_HEADLESS_HEIGHT=1000

timeout "$TIMEOUT" "$ZOTERO" -profile "$PROFILE" -no-remote -ZoteroDebugText > "$LOG" 2>&1 || true

if [ -f "$OUT" ]; then
  cat "$OUT"
  python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("ok") is True else 1)' "$OUT"
else
  echo "No result written. Last log lines:"; tail -40 "$LOG"; exit 1
fi
