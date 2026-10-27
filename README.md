# opencode-nvidia-models

Keeps OpenCode's NVIDIA (build.nvidia.com) model list in sync with what the API actually serves **and works for your API key**.

**Tests ALL models on startup** — only models that successfully respond to chat completions appear in the picker.

## One-line install

```bash
# 1) add the plugin
opencode plugin add github:rmrtnv/opencode-nvidia-models

# 2) give it your API key (activates the provider)
export NVIDIA_API_KEY="nvapi-..."
# or: ./install.sh --key nvapi-...
```

Restart OpenCode once, then run `/models` and pick any `nvidia/` model.

## What it does

| Feature | How |
|---|---|
| **Dynamic discovery** | Every 6h (configurable) calls `GET /v1/models` — no hardcoded lists. |
| **Proactive health check** | On startup, tests ALL live models with a quick chat completion (3 concurrent, 10s timeout). Only responding models added to picker. |
| **Cache & retry** | Results cached 7 days. Failed models re-tested on each refresh. Network hiccups never empty your list. |
| **Prune retired** | Models the API stops serving are removed from picker. |
| **Zero-config provider** | Updates the catalog `nvidia` provider with your `baseURL` + key. |

## How it works

1. **Fetch live inventory** from `https://integrate.api.nvidia.com/v1/models` (~85 models)
2. **Test each model** with `POST /chat/completions` (5 tokens, "hi")
3. **Only healthy models** appear in `/models` picker
4. **Cache results** 7 days — failed models re-tested on next refresh

This naturally filters to **models your API key can actually access** (free tier, paid tier, regional availability, etc.) — no need for credit checks or hardcoded free lists.

## Config (created by `install.sh`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "nvidia/nemotron-3-ultra-550b-a55b",
  "plugins": [
    { "package": "github:rmrtnv/opencode-nvidia-models",
      "options": { "refreshHours": 6 } }
  ],
  "providers": {
    "nvidia": {
      "settings": {
        "baseURL": "https://integrate.api.nvidia.com/v1",
        "apiKey": "nvapi-..."          // or rely on NVIDIA_API_KEY env var
      }
    }
  }
}
```

## Options

| Option | Default | Purpose |
|---|---|---|
| `apiKey` | `NVIDIA_API_KEY` → config | Credential for discovery + health checks. |
| `baseURL` | `https://integrate.api.nvidia.com/v1` | Provider endpoint (also discovery unless overridden). |
| `discoveryURL` | `baseURL` | Separate `GET /models` endpoint (e.g. behind a gateway). |
| `refreshHours` | `6` | Re-check interval (min 1). |

## Inspect model status

Plugin logs a summary on startup:
```
health check complete: 7/85 models healthy
```

Full status cached at `nvidia/model-status` (query via OpenCode storage).

## Why no `extraModels` / `includeFreeModels`?

- **No hardcoded lists** — the API is the source of truth
- **No manual allowlists** — if the API serves it and it works, it's in the picker
- **No free/paid distinction** — health check reveals what your key can access

## License

MIT