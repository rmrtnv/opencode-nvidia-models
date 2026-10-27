#!/usr/bin/env bash
# Install the NVIDIA model-sync plugin and store your API key in OpenCode's
# global config. Safe to re-run: it merges instead of overwriting.
#
# Usage:
#   ./install.sh --key nvapi-...                     # npm/GitHub install
#   ./install.sh --key nvapi-... --plugin github:you/opencode-nvidia-models
#   ./install.sh --key nvapi-... --plugin /path/to/opencode-nvidia-models
#   ./install.sh --key nvapi-... --refresh-hours 24
#   ./install.sh --key nvapi-... --extra-model nvidia/nemotron-3.5-bolt-e4b
#
# The key can also come from $NVIDIA_API_KEY instead of --key.

set -euo pipefail

PLUGIN_SPEC=""
API_KEY="${NVIDIA_API_KEY:-}"
REFRESH_HOURS="6"
SET_DEFAULT="yes"
EXTRA_MODELS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --key) API_KEY="${2:-}"; shift 2 ;;
    --plugin) PLUGIN_SPEC="${2:-}"; shift 2 ;;
    --refresh-hours) REFRESH_HOURS="${2:-}"; shift 2 ;;
    --extra-model) EXTRA_MODELS+=("${2:-}"); shift 2 ;;
    --no-default) SET_DEFAULT="no"; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_FILE="$CONFIG_HOME/opencode/opencode.json"
DEFAULT_MODEL="nvidia/deepseek-ai/deepseek-v4.1-flash"

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
    echo "==> local plugin directory, adding to $CONFIG_FILE"
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
EXTRA_MODELS="$(IFS=,; echo "${EXTRA_MODELS[*]:-}")" \
python3 - <<'PY'
import json, os, sys

path = os.environ["CONFIG_FILE"]
spec = os.environ["PLUGIN_SPEC"]
key = os.environ["API_KEY"]
hours = max(1, int(float(os.environ["REFRESH_HOURS"])))
default_model = os.environ["DEFAULT_MODEL"]
set_default = os.environ["SET_DEFAULT"] == "yes"
extras = [entry for entry in os.environ.get("EXTRA_MODELS", "").split(",") if entry]

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
            if extras:
                merged = list(options.get("extraModels") or [])
                merged += [entry for entry in extras if entry not in merged]
                options["extraModels"] = merged
            plugins[index] = {"package": spec, "options": options}
            break
    else:
        options = {"refreshHours": hours}
        if extras:
            options["extraModels"] = extras
        plugins.append({"package": spec, "options": options})

if set_default and not str(cfg.get("model", "")).startswith("nvidia/"):
    cfg["model"] = default_model

with open(path, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")

print(f"updated {path}")
PY

echo
echo "Done. Restart OpenCode once, then run /models and pick an nvidia/ model."
