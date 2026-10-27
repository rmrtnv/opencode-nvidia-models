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

## Minimal config (put in `~/.config/opencode/opencode.json`)

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
| `extraModels` | `[]` | Model IDs to expose when live but missing from the catalog. |

## Reinstall / new machine

```bash
opencode plugin add github:rmrtnv/opencode-nvidia-models
export NVIDIA_API_KEY="nvapi-..."   # or copy your opencode.json
```

`opencode uninstall` keeps config and sessions, so a reinstall on the same machine needs nothing else.

## Why not MCP / plain config?

* **Config alone** is static — retired endpoints linger until you edit the file.  
* **MCP** gives agents tools/data, it cannot register or prune models.  
* **A plugin** is the only extension point that can add/remove provider models at runtime (`ctx.provider.transform`, `ctx.model.transform`).

## License

MIT