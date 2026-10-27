import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * opencode-nvidia-models
 *
 * Keeps `nvidia/*` entries in OpenCode's model picker aligned with the models
 * the NVIDIA API actually serves.
 *
 * Behaviour:
 *   - On load, and every `refreshHours` (default 6), asks
 *     `${discoveryURL}/models` which model IDs exist right now.
 *   - Removes catalog models that the API no longer returns (retired models).
 *   - Keeps the last good answer for 7 days, so a network hiccup or a region
 *     block never empties your model list.
 *   - Never invents models: anything the API adds shows up as soon as the
 *     models.dev catalog (which OpenCode already ships) lists it.
 *
 * The provider itself (endpoint + API key) can be supplied here too, so a fresh
 * OpenCode install needs no hand-written `providers.nvidia` block.
 */

const PROVIDER = "nvidia"
const DEFAULT_DISCOVERY = "https://integrate.api.nvidia.com/v1"
const DEFAULT_REFRESH_HOURS = 6
const CACHE_KEY = "nvidia/live-inventory"
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000
const MIN_PLAUSIBLE_MODELS = 3
const RETRY_MINUTES = 30

type Options = {
  apiKey?: string
  baseURL?: string
  refreshHours?: number
  discoveryURL?: string
  addUnknown?: boolean
}

type Cache = { at: number; ids: string[] }

/** API key from the global config, so users do not have to repeat it in options. */
function keyFromConfig(): string | undefined {
  const roots = [process.env.XDG_CONFIG_HOME, join(homedir(), ".config")].filter(
    (entry): entry is string => Boolean(entry),
  )
  for (const root of roots) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      try {
        const raw = readFileSync(join(root, "opencode", file), "utf8")
        const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
        const modern = json?.providers?.[PROVIDER]?.settings?.apiKey
        const legacy = json?.provider?.[PROVIDER]?.options?.apiKey
        const key = modern ?? legacy
        if (typeof key === "string" && key.length > 0) return key
      } catch {
        // missing/invalid file: try the next candidate
      }
    }
  }
  return undefined
}

function log(message: string) {
  console.log(`[nvidia-models] ${message}`)
}

async function fetchLiveModels(discoveryURL: string, apiKey: string, signal: AbortSignal): Promise<string[]> {
  const url = `${discoveryURL.replace(/\/+$/, "")}/models`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
  const ids = (body.data ?? []).map((model) => model?.id).filter((id): id is string => typeof id === "string")

  // A couple of models can legitimately be missing, but a near-empty answer is
  // almost always a gateway/proxy page rather than the real inventory.
  if (ids.length < MIN_PLAUSIBLE_MODELS) {
    throw new Error(`suspiciously short inventory (${ids.length} models)`)
  }
  return ids
}

export default Plugin.define({
  id: "nvidia-models",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options

    const apiKey = options.apiKey || process.env.NVIDIA_API_KEY || keyFromConfig()
    const baseURL = options.baseURL || process.env.NVIDIA_BASE_URL || DEFAULT_DISCOVERY
    const discoveryURL = options.discoveryURL || baseURL
    const refreshHours = Math.max(1, Number(options.refreshHours) || DEFAULT_REFRESH_HOURS)
    const interval = refreshHours * 60 * 60 * 1000
    const addUnknown = options.addUnknown === true

    const state: { live?: Set<string>; warnedNoKey: boolean } = { warnedNoKey: false }

    // Warm start: reuse a recent inventory so a restart during an outage keeps
    // the list correct instead of falling back to stale catalog entries.
    try {
      const cached = (await ctx.storage.get(CACHE_KEY)) as Cache | undefined
      if (cached && Array.isArray(cached.ids) && Date.now() - cached.at < CACHE_MAX_AGE) {
        state.live = new Set(cached.ids)
      }
    } catch (error) {
      log(`could not read cache: ${String(error)}`)
    }

    // Provider registration: makes a fresh install work with just an API key.
    // With addUnknown, live models that the catalog does not know yet are added
    // with conservative limits, so an endpoint NVIDIA serves today is usable
    // before models.dev catches up.
    try {
      await ctx.provider.transform((editor) => {
        const settings: Record<string, unknown> = { baseURL }
        if (apiKey) settings.apiKey = apiKey

        if (editor.get(PROVIDER)) {
          editor.update(PROVIDER, (provider) => {
            provider.settings = { ...(provider.settings as Record<string, unknown> | undefined), ...settings }
          })
        } else {
          editor.add({
            info: {
              ...Provider.Info.empty(Provider.ID.make(PROVIDER)),
              name: "NVIDIA (build.nvidia.com)",
              activation: "enabled",
              package: "@opencode/ai/providers/openai-compatible",
              settings,
            },
            models: [],
          })
        }

        const live = state.live
        const record = editor.get(PROVIDER)
        if (!addUnknown || !live || !record) return

        const missing = [...live].filter((id) => !record.models.has(id))
        if (missing.length === 0) return

        const added = missing.map((id) => ({
          id,
          modelID: id,
          providerID: PROVIDER,
          name: id.split("/").pop() ?? id,
          type: "chat" as const,
          variants: [],
          time: { released: 0 },
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          status: "active" as const,
          enabled: true,
          limit: { context: 65_536, output: 8_192 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        }))
        editor.models.set(PROVIDER, [...record.models.values(), ...added])
      })
    } catch (error) {
      log(`provider transform failed: ${String(error)}`)
    }

    // Model registration: drop whatever the API no longer serves.
    await ctx.model.transform((editor) => {
      const live = state.live
      if (!live || live.size === 0) return
      for (const model of editor.list(PROVIDER)) {
        if (!live.has(model.id)) editor.remove(PROVIDER, model.id)
      }
    })

    const refresh = async (): Promise<boolean> => {
      if (!apiKey) {
        if (!state.warnedNoKey) {
          state.warnedNoKey = true
          log("no API key found (option, NVIDIA_API_KEY, or config); keeping the catalog list as-is")
        }
        return true
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      try {
        const ids = await fetchLiveModels(discoveryURL, apiKey, controller.signal)
        const next = new Set(ids)
        const before = state.live
        state.live = next

        await ctx.storage.set(CACHE_KEY, { at: Date.now(), ids } satisfies Cache)
        // Provider transform adds live-but-uncatalogued models; the model
        // transform prunes retired ones. Both need a rebuild to see `state.live`.
        await ctx.provider.reload()
        await ctx.model.reload()

        if (!before) {
          log(`loaded ${next.size} live models`)
        } else {
          const removed = [...before].filter((id) => !next.has(id))
          const added = [...next].filter((id) => !before.has(id))
          if (removed.length || added.length) {
            log(
              `inventory changed: +${added.length} new (${added.join(", ") || "none"}), ` +
                `-${removed.length} retired (${removed.join(", ") || "none"})`,
            )
          } else {
            log(`inventory unchanged (${next.size} models)`)
          }
        }
        return true
      } catch (error) {
        // Keep the previous inventory: a blocked network must not break models.
        // Retry sooner than the normal interval, then fall back to the schedule.
        log(`live check failed, keeping last known list: ${String(error)}`)
        return false
      } finally {
        clearTimeout(timeout)
      }
    }

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      const ok = await refresh()
      if (stopped) return
      timer = setTimeout(() => void tick(), ok ? interval : RETRY_MINUTES * 60 * 1000)
    }

    await tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  },
})
