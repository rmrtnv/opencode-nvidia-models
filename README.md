# opencode-nvidia-models

Keeps OpenCode's NVIDIA (build.nvidia.com) model list in sync with the live API.
Retires models the API stops serving; optionally exposes live-but-uncatalogued models
(e.g. `nvidia/nemotron-3.5-bolt-e4b`) via an allow-list.

## One-line install

```bash
# 1) add the plugin
opencode plugin add github:rmrtnv/opencode-nvidia-models

# 2) give it your API key (activates the provider)
export NVIDIA_API_KEY="nvapi-..."
# or: ./install.sh --key nvapi-... --extra-model nvidia/nemotron-3.5-bolt-e4b
```

Restart OpenCode once, then run `/models` and pick any `nvidia/` model.

## What it does

| Feature | How |
|---|---|
| **Prune retired models** | Every 6 h (configurable) it calls `GET /v1/models`; any catalog model not in the response is removed. |
| **Cache & retry** | Last good inventory cached 7 days. On HTTP 451 / network failure it keeps the cached list and retries in 30 min. |
| **Extra models** | `extraModels: ["nvidia/nemotron-3.5-bolt-e4b"]` adds models the API serves but models.dev hasn't catalogued yet, with safe defaults (64 k context, tools enabled). |
| **Zero-config provider** | The plugin only *updates* the catalog `nvidia` provider with your `baseURL` + key. You still need the key in `providers.nvidia.settings.apiKey` or `NVIDIA_API_KEY` to activate it. |

## Config (usually created by `install.sh`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "nvidia/deepseek-ai/deepseek-v4.1-flash",
  "plugins": [
    { "package": "github:rmrtnv/opencode-nvidia-models",
      "options": { "refreshHours": 6,
                   "extraModels": ["nvidia/nemotron-3.5-bolt-e4b"] } }
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
| `apiKey` | `NVIDIA_API_KEY` → config | Credential used for the discovery request only. |
| `baseURL` | `https://integrate.api.nvidia.com/v1` | Provider endpoint (also discovery unless overridden). |
| `discoveryURL` | `baseURL` | Separate `GET /models` endpoint (e.g. behind a gateway). |
| `refreshHours` | `6` | Re-check interval (min 1). |
| `extraModels` | `[]` | Explicit allow-list of model IDs to expose when live but missing from the catalog. |
| `includeFreeModels` | `false` | If `true`, automatically adds all known free-tier models that are currently live (uses a built-in list synced from the NVIDIA free models page). |

### `extraModels` vs `includeFreeModels`

* **`extraModels`** – manual allow-list. Use when you want to cherry-pick a specific model (e.g. a newly released model not yet in the catalog).
* **`includeFreeModels: true`** – hands-free: the plugin knows the 30+ free-tier model IDs (from NVIDIA’s published free list) and will surface any of them that the API is serving right now. No need to track IDs yourself.

You can use both together.

#### Example: enable all free models + one extra

```jsonc
{
  "plugins": [
    {
      "package": "github:rmrtnv/opencode-nvidia-models",
      "options": {
        "refreshHours": 6,
        "includeFreeModels": true,
        "extraModels": ["nvidia/nemotron-3.5-bolt-e4b"]
      }
    }
  ],
  "providers": {
    "nvidia": {
      "settings": {
        "baseURL": "https://integrate.api.nvidia.com/v1",
        "apiKey": "nvapi-..."
      }
    }
  }
}
```

#### Advanced: discover candidates manually

If you prefer to curate the list yourself, fetch the live inventory once:

```bash
curl -H "Authorization: Bearer $NVIDIA_API_KEY" https://integrate.api.nvidia.com/v1/models | jq '.data[].id'
```

Compare that to `/models` in OpenCode; any API ID missing from the picker can be added via `extraModels`.

## Reinstall / new machine

```bash
opencode plugin add github:rmrtnv/opencode-nvidia-models
export NVIDIA_API_KEY="nvapi-..."   # or copy your opencode.json
```

`opencode uninstall` keeps config and sessions, so a reinstall on the same machine needs nothing else.

## License

MIT