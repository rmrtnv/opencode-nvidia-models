#!/usr/bin/env bash
# Install the NVIDIA model-sync plugin and store your API key in OpenCode's
# global config. Safe to re-run: it merges instead of overwriting.
#
# Usage:
#   ./install.sh --key nvapi-... [--refresh-hours 6] [--plugin github:rmrtnv/opencode-nvidia-models]
#
# Key can also come from $NVIDIA_API_KEY (no --key needed).

set -euo pipefail

PLUGIN_SPEC=""
API_KEY="${NVIDIA_API_KEY:-}"
REFRESH_HOURS="6"
SET_DEFAULT="yes"

while [ $# -gt 0 ]; do
  case "$1" in
    --key) API_KEY="${2:-}"; shift 2 ;;
    --plugin) PLUGIN_SPEC="${2:-}"; shift 2 ;;
    --refresh-hours) REFRESH_HOURS="${2:-}"; shift 2 ;;
    --no-default) SET_DEFAULT="no"; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_FILE="$CONFIG_HOME/opencode/opencode.json"
DEFAULT_MODEL="nvidia/nemotron-3-ultra-550b-a55b"

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: 'opencode' is not on PATH" >&2
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "error: pass --key nvapi-... or export NVIDIA_API_KEY" >&2
  exit 1
fi

if [ -n "$PLUGIN_SPEC" ]; then
  if [ -d "$PLUGIN_SPEC" ]; then
    PLUGIN_SPEC="$(cd "$PLUGIN_SPEC" && pwd)"
    echo "==> local plugin directory ($PLUGIN_SPEC), adding to $CONFIG_FILE"
  else
    echo "==> opencode plugin add $PLUGIN_SPEC"
    opencode plugin add "$PLUGIN_SPEC"
  fi
fi

mkdir -p "$(dirname "$CONFIG_FILE")"
[ -f "$CONFIG_FILE" ] || echo '{}' > "$CONFIG_FILE"
cp "$CONFIG_FILE" "$CONFIG_FILE.bak.$(date +%s)"

CONFIG_FILE="$CONFIG_FILE" \
PLUGIN_SPEC="$PLUGIN_SPEC" \
API_KEY="$API_KEY" \
REFRESH_HOURS="$REFRESH_HOURS" \
DEFAULT_MODEL="$DEFAULT_MODEL" \
SET_DEFAULT="$SET_DEFAULT" \
python3 - <<'PY'
import json, os, sys

path = os.environ["CONFIG_FILE"]
spec = os.environ["PLUGIN_SPEC"]
key = os.environ["API_KEY"]
hours = max(1, int(float(os.environ["REFRESH_HOURS"])))
default_model = os.environ["DEFAULT_MODEL"]
set_default = os.environ["SET_DEFAULT"] == "yes"

try:
    with open(path) as fh:
        cfg = json.load(fh)
except json.JSONDecodeError as exc:
    sys.exit(f"error: {path} is not valid JSON ({exc}); fix it first")

cfg.setdefault("$schema", "https://opencode.ai/config.json")
cfg.setdefault("providers", {}).setdefault("nvidia", {})
cfg["providers"]["nvidia"].setdefault("settings", {})
cfg["providers"]["nvidia"]["settings"]["apiKey"] = key
cfg["providers"]["nvidia"]["settings"].setdefault("baseURL", "https://integrate.api.nvidia.com/v1")

# Plugin entry: only rewritten when this script was told about one.
if spec:
    plugins = cfg.setdefault("plugins", [])
    for index, existing in enumerate(plugins):
        name = existing.get("package") if isinstance(existing, dict) else existing
        if isinstance(name, str) and "nvidia-models" in name:
            options = dict(existing.get("options") or {}) if isinstance(existing, dict) else {}
            options["refreshHours"] = hours
            plugins[index] = {"package": spec, "options": options}
            break
    else:
        plugins.append({"package": spec, "options": {"refreshHours": hours}})

if set_default and not str(cfg.get("model", "")).startswith("nvidia/"):
    cfg["model"] = default_model

with open(path, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")

print(f"updated {path}")
PY

echo
echo "Done. Restart OpenCode once, then run /models and pick an nvidia/ model."
echo "Plugin will test all API models on startup and only show working ones."