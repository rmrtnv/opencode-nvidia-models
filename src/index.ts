import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * opencode-nvidia-models
 *
 * Keeps `nvidia/*` entries in OpenCode's model picker aligned with the models
 * the NVIDIA API actually serves AND that work for the user's API key.
 *
 * Behaviour:
 *   - On load, and every `refreshHours` (default 6), asks
 *     `${discoveryURL}/models` which model IDs exist right now.
 *   - Tests ALL live models with a quick chat completion (concurrent, 10s timeout).
 *   - Only models that respond successfully are added to the picker.
 *   - Results cached 7 days. Failed models retested on next refresh.
 *   - Removes catalog models that the API no longer returns (retired models).
 *   - Keeps the last good answer for 7 days, so a network hiccup or a region
 *     block never empties your model list.
 *
 * The provider itself (endpoint + API key) can be supplied here too, so a fresh
 * OpenCode install needs no hand-written `providers.nvidia` block.
 */

const PROVIDER = "nvidia"
const DEFAULT_DISCOVERY = "https://integrate.api.nvidia.com/v1"
const DEFAULT_REFRESH_HOURS = 6
const CACHE_KEY = "nvidia/live-inventory"
const HEALTH_CACHE_KEY = "nvidia/model-health"
const STATUS_CACHE_KEY = "nvidia/model-status"
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000
const MIN_PLAUSIBLE_MODELS = 3
const RETRY_MINUTES = 30
const HEALTH_TIMEOUT_MS = 8_000
const HEALTH_CONCURRENCY = 5

type Options = {
  apiKey?: string
  baseURL?: string
  refreshHours?: number
  discoveryURL?: string
  testAllOnStartup?: boolean
}

type Cache = { at: number; ids: string[] }
type HealthCache = { at: number; results: Record<string, boolean> }
type StatusEntry = { id: string; status: "healthy" | "failed" | "untested" | "not-live"; live: boolean }

/** API key from the global config, so users do not have to repeat it in options. */
function keyFromConfig(): string | undefined {
  const candidates: string[] = []
  if (process.env.OPENCODE_CONFIG) candidates.push(process.env.OPENCODE_CONFIG)
  const roots = [process.env.XDG_CONFIG_HOME, join(homedir(), ".config")].filter(
    (entry): entry is string => Boolean(entry),
  )
  for (const root of roots) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      candidates.push(join(root, "opencode", file))
    }
  }

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8")
      const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
      const modern = json?.providers?.[PROVIDER]?.settings?.apiKey
      const legacy = json?.provider?.[PROVIDER]?.options?.apiKey
      const key = modern ?? legacy
      if (typeof key === "string" && key.length > 0) return key
    } catch {
      // missing/invalid file: try the next candidate
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

  if (ids.length < MIN_PLAUSIBLE_MODELS) {
    throw new Error(`suspiciously short inventory (${ids.length} models)`)
  }
  return ids
}

/** Test a model with a quick chat completion. Returns true if it works. */
async function testModelHealth(baseURL: string, apiKey: string, modelId: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      log(`health check failed for ${modelId}: HTTP ${response.status} ${err.error?.message ?? ""}`)
      return false
    }
    const data = await response.json()
    return Boolean(data.choices?.[0]?.message?.content)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      log(`health check timeout for ${modelId} (${HEALTH_TIMEOUT_MS}ms)`)
    } else {
      log(`health check error for ${modelId}: ${String(error)}`)
    }
    return false
  } finally {
    clearTimeout(timeout)
  }
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
    const testAllOnStartup = options.testAllOnStartup === true

    const state: { live?: Set<string>; warnedNoKey: boolean; healthCache?: HealthCache } = {
      warnedNoKey: false,
    }

    // Load health cache
    try {
      const cached = (await ctx.storage.get(HEALTH_CACHE_KEY)) as HealthCache | undefined
      if (cached && Date.now() - cached.at < CACHE_MAX_AGE) {
        state.healthCache = cached
      }
    } catch (error) {
      log(`could not read health cache: ${String(error)}`)
    }

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

    /** Test all live models, return set of healthy ones. */
    const runHealthChecks = async (live: Set<string>): Promise<Set<string>> => {
      if (!apiKey || !live || live.size === 0) return live

      const cache = state.healthCache ?? { at: Date.now(), results: {} }
      const healthy = new Set<string>()
      const toTest = [...live]

      log(`health check: testing ${toTest.length} models (${HEALTH_CONCURRENCY} concurrent, ${HEALTH_TIMEOUT_MS}ms timeout)...`)

      for (let i = 0; i < toTest.length; i += HEALTH_CONCURRENCY) {
        const batch = toTest.slice(i, i + HEALTH_CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (modelId) => {
            if (cache.results[modelId] !== undefined) {
              return { modelId, healthy: cache.results[modelId] }
            }
            log(`  testing ${modelId}...`)
            const h = await testModelHealth(baseURL, apiKey, modelId)
            cache.results[modelId] = h
            return { modelId, healthy: h }
          })
        )
        for (const { modelId, healthy: h } of results) {
          if (h) healthy.add(modelId)
          else log(`  ✗ failed: ${modelId}`)
        }
      }

      cache.at = Date.now()
      state.healthCache = cache
      try {
        await ctx.storage.set(HEALTH_CACHE_KEY, cache)
      } catch (e) {
        log(`failed to save health cache: ${String(e)}`)
      }

      log(`health check complete: ${healthy.size}/${toTest.length} models healthy`)
      return healthy
    }

    /** Save status summary for inspection. */
    const saveStatus = async (live: Set<string>, healthy: Set<string>) => {
      const entries: StatusEntry[] = [...live].map((id) => ({
        id,
        status: healthy.has(id) ? "healthy" : state.healthCache?.results[id] === false ? "failed" : "untested",
        live: true,
      }))
      try {
        await ctx.storage.set(STATUS_CACHE_KEY, { at: Date.now(), entries })
      } catch (e) {
        log(`failed to save status cache: ${String(e)}`)
      }
    }

    // Initial refresh: fetch live inventory, then health check all in background
    const initialRefresh = async (): Promise<boolean> => {
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
        const live = new Set(ids)
        state.live = live

        await ctx.storage.set(CACHE_KEY, { at: Date.now(), ids: [...live] } satisfies Cache)

        // Start health checks in background (non-blocking)
        runHealthChecks(live).then((healthy) => {
          state.live = healthy
          saveStatus(live, healthy)
          ctx.model.reload().catch(() => {})
          log(`background health check complete: ${healthy.size}/${live.size} models healthy`)
        })

        log(`loaded ${live.size} live models, health checking in background...`)
        return true
      } catch (error) {
        log(`initial live check failed: ${String(error)}`)
        return false
      } finally {
        clearTimeout(timeout)
      }
    }

    // Run initial refresh first
    await initialRefresh()

    // Provider registration: attach our endpoint + key to the catalog provider.
    // Never add a provider here: adding one shadows the catalog source and
    // replaces its model inventory with an empty list.
    try {
      await ctx.provider.transform((editor) => {
        const record = editor.get(PROVIDER)
        if (!record) return

        const settings: Record<string, unknown> = { baseURL }
        if (apiKey) settings.apiKey = apiKey

        editor.update(PROVIDER, (provider) => {
          provider.settings = { ...(provider.settings as Record<string, unknown> | undefined), ...settings }
        })

        const live = state.live
        if (!live || live.size === 0) return

        // Only add models that passed health check and aren't already in catalog
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

    /** Check model health on demand (lazy). Returns true if healthy. */
    const checkHealth = async (modelId: string): Promise<boolean> => {
      if (!apiKey) return true

      const cache = state.healthCache ?? { at: Date.now(), results: {} }
      if (cache.results[modelId] !== undefined) {
        return cache.results[modelId]
      }

      log(`lazy health check: ${modelId}...`)
      const healthy = await testModelHealth(baseURL, apiKey, modelId)
      cache.results[modelId] = healthy
      cache.at = Date.now()
      state.healthCache = cache

      try {
        await ctx.storage.set(HEALTH_CACHE_KEY, cache)
      } catch (e) {
        log(`failed to save health cache: ${String(e)}`)
      }

      if (!healthy) {
        log(`disabling unhealthy model: ${modelId}`)
        await ctx.model.transform((editor) => {
          editor.remove(PROVIDER, modelId)
        })
      }
      return healthy
    }

    // Periodic refresh
    const refresh = async (): Promise<boolean> => {
      if (!apiKey) {
        if (!state.warnedNoKey) {
          state.warnedNoKey = true
          log("no API key found; keeping the catalog list as-is")
        }
        return true
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      try {
        const ids = await fetchLiveModels(discoveryURL, apiKey, controller.signal)
        const nextLive = new Set(ids)
        const before = state.live ?? new Set()

        await ctx.storage.set(CACHE_KEY, { at: Date.now(), ids: [...nextLive] } satisfies Cache)

        // Health check new models
        const newModels = [...nextLive].filter((id) => !before.has(id))
        let healthy = new Set(state.live ?? [])
        
        if (newModels.length > 0) {
          log(`refresh: ${newModels.length} new models, testing...`)
          const healthyNew = await runHealthChecks(new Set(newModels))
          for (const id of healthyNew) healthy.add(id)
        }

        // Re-test previously failed models (they might work now)
        const failedBefore = [...before].filter((id) => state.healthCache?.results[id] === false)
        if (failedBefore.length > 0) {
          log(`refresh: re-testing ${failedBefore.length} previously failed models...`)
          const healthyRetest = await runHealthChecks(new Set(failedBefore))
          for (const id of healthyRetest) healthy.add(id)
        }

        state.live = healthy
        await saveStatus(nextLive, healthy)
        await ctx.model.reload()

        const added = [...healthy].filter((id) => !before.has(id))
        const removed = [...before].filter((id) => !healthy.has(id))
        if (added.length || removed.length) {
          log(`inventory changed: +${added.length} healthy, -${removed.length} removed/failed`)
        } else {
          log(`inventory unchanged: ${healthy.size} healthy models`)
        }
        return true
      } catch (error) {
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

    timer = setTimeout(() => void tick(), interval)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  },
})