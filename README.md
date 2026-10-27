# opencode-nvidia-models

One plugin that gives [OpenCode](https://opencode.ai) a working, always-current
NVIDIA (build.nvidia.com) model list — no hand-written provider block, and no
manual cleanup when NVIDIA retires a model.

## Why this exists

OpenCode already ships an NVIDIA entry in its [models.dev](https://models.dev)
catalog. Two things still go wrong in practice:

1. **Retired models linger.** When NVIDIA drops an endpoint (for example
   `nvidia/nemotron-3.5-bolt-e4b`), the entry can stay selectable and then fail
   at request time.
2. **A working provider block is easy to get wrong.** V1-shaped `provider`
   config is silently skipped by OpenCode V2 — the whole provider disappears and
   `/models` shows nothing.

This plugin fixes both: it registers the provider for you, and it keeps the
model list aligned with what the API actually serves.

## What it does

- Registers the `nvidia` provider (endpoint + API key), so a fresh OpenCode
  install needs no `providers.nvidia` block in your config.
- On startup, and every `refreshHours` (default **6 hours**), asks
  `GET {baseURL}/models` which model IDs exist right now.
- Removes catalog models the API no longer returns.
- Caches the last good answer for **7 days**, so a network block, a VPN drop, or
  a region restriction (HTTP 451) never empties your model list.
- Rejects implausibly short responses (fewer than 3 models) and retries after
  **30 minutes** instead of wiping the list.
- With `addUnknown: true`, also exposes models the API serves but the catalog
  does not know yet — using conservative limits (64K context, text-only tools).
  They disappear on the next refresh if NVIDIA stops serving them.

## Live inventory vs the catalog (why some models are missing)

OpenCode's catalog comes from models.dev, which is curated, not exhaustive. On
2026-10-26 the NVIDIA API served **85** model IDs while models.dev listed **52**.
So a model can be genuinely live and still be absent from `/models`.

`nvidia/nemotron-3.5-bolt-e4b` is exactly this case: present in the API snapshot
from 2026-10-26, absent from models.dev today. Two ways to keep it:

```jsonc
// a) explicit entry, pruned automatically once your API stops serving it
{ "providers": { "nvidia": { "models": { "nvidia/nemotron-3.5-bolt-e4b": {} } } } }

// b) let the plugin mirror the live inventory (recommended)
{ "plugins": [{ "package": "opencode-nvidia-models", "options": { "addUnknown": true } }] }
```

## Install

```bash
opencode plugin add github:<you>/opencode-nvidia-models
```

Then give it an API key — any **one** of these:

```bash
# 1. environment (simplest)
export NVIDIA_API_KEY="nvapi-..."
```

```jsonc
// 2. global config, ~/.config/opencode/opencode.json
{
  "providers": { "nvidia": { "settings": { "apiKey": "nvapi-..." } } },
}
```

```jsonc
// 3. plugin options
{
  "plugins": [
    { "package": "opencode-nvidia-models", "options": { "apiKey": "nvapi-..." } },
  ],
}
```

Restart OpenCode once after installing the plugin (config edits alone are picked
up live, but the plugin set is read at server start). Then run `/models`.

## Local development

```jsonc
{
  "plugins": [
    { "package": "/absolute/path/to/opencode-nvidia-models", "options": { "refreshHours": 6 } },
  ],
}
```

## Options

| Option         | Default                            | Purpose                                                        |
| -------------- | ---------------------------------- | -------------------------------------------------------------- |
| `apiKey`       | `NVIDIA_API_KEY`, then config      | Credential used for the discovery request.                     |
| `baseURL`      | `https://integrate.api.nvidia.com/v1` | Provider endpoint (also used for discovery unless overridden). |
| `discoveryURL` | value of `baseURL`                 | Separate endpoint for `GET /models` (useful behind a gateway). |
| `refreshHours` | `6`                                | How often to re-check the inventory. Minimum 1.                |
| `addUnknown`   | `false`                            | Also expose live models missing from the catalog, with conservative limits. |

Failed checks retry after 30 minutes regardless of `refreshHours`.

## Choosing a refresh interval

- **6 hours (default):** NVIDIA changes its free-tier lineup on the order of
  days to weeks; four checks a day is plenty and costs one small GET each time.
- **24 hours:** if you want the minimum chatter and are happy to see a retired
  model for up to a day.
- **1 hour:** only useful if you are actively tracking a rollout.

The request is a single authenticated `GET /v1/models`; it does not consume
tokens or count against chat rate limits.

## Reinstalling OpenCode / moving to a new machine

Nothing here lives inside the OpenCode binary:

| What                    | Where                                              | Survives reinstall |
| ----------------------- | -------------------------------------------------- | ------------------ |
| Plugin + model sync     | this repo, installed via `opencode plugin add`      | no — reinstall it  |
| Provider settings + key | `~/.config/opencode/opencode.json`                  | yes                |
| Sessions, history       | `~/.local/share/opencode/opencode.db`               | yes (uninstall keeps it) |

`opencode uninstall` keeps configuration and session data, so a reinstall on the
same machine needs nothing. On a **new machine**:

```bash
# 1. install OpenCode, then
opencode plugin add github:<you>/opencode-nvidia-models
# 2. restore the key (copy the file, or re-export it)
cp /backup/opencode.json ~/.config/opencode/opencode.json
# 3. optional: copy sessions too
cp /backup/opencode.db ~/.local/share/opencode/opencode.db
```

That is the whole setup — no MCP server required.

## MCP, plugin, or config?

- **Config** alone is enough to *define* models, but it is static: retired
  endpoints stay listed until you edit the file.
- **MCP** is for giving the agent tools and data sources (files, databases,
  APIs). It has nothing to do with model providers — it cannot register models.
- **A plugin** is the only OpenCode extension point that can add, prune, and
  refresh provider models at runtime ([providers guide](https://opencode.ai/v2/docs/providers),
  [plugin API](https://opencode.ai/v2/docs/build/plugins/server)). That is what
  this package uses.

## Verified behaviour

Tested against OpenCode 2.2.0:

- Live inventory reached → retired models pruned (`21 → 2` in a mock test).
- `addUnknown: true` → a live model absent from the catalog is added with
  conservative limits (`2 → 3`, new entry selectable).
- API returns HTTP 451 (region-blocked) → catalog list kept, warning logged.
- Discovery endpoint down on restart → cached inventory reused, list intact.
- Truncated 1-model response → rejected, previous list kept.
- No `providers.nvidia` block in config → provider still registered from the
  plugin's `apiKey`, models listed.

## License

MIT
