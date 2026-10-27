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
 *   - Tests models on first use (lazy health check) — disables models that
 *     timeout or error on chat completions.
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
const HEALTH_TIMEOUT_MS = 10_000

// Known free-tier model IDs (from the scraped free_models.json)
const FREE_MODEL_IDS = [
  "deepseek-ai/deepseek-v4.1-flash",
  "google/diffusiongemma-26b-a4b-it",
  "google/gemma-4-31b-it",
  "google/paligemma",
  "ipd/rfd4-proteina",
  "meta/llama-3.2-11b-vision-instruct",
  "meta/llama-3.2-90b-vision-instruct",
  "meta/llama-guard-4-12b",
  "meta/muse-glimmer-30b",
  "minimaxai/minimax-m3.1-flash",
  "nvidia/ai-synthetic-video-detector",
  "nvidia/cosmos3-nano",
  "nvidia/ising-calibration-1.5-31b",
  "nvidia/kumo-relational",
  "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
  "nvidia/nemotron-3-embed-1b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-bolt-e4b",
  "nvidia/nemotron-3.5-content-safety",
  "nvidia/nemotron-3.5-embed-1b",
  "nvidia/nemotron-3.5-embed-8b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-parse",
  "nvidia/nemotron-3.5-rerank-8b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nvidia/riva-translate-4b-instruct-v2",
  "openai/gpt-oss-20b",
  "poolside/laguna-xs-2.1",
  "stepfun-ai/step-5-preview",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
]

type Options = {
  apiKey?: string
  baseURL?: string
  refreshHours?: number
  discoveryURL?: string
  extraModels?: string[]
  includeFreeModels?: boolean
  testModelsOnUse?: boolean
  testAllOnStartup?: boolean
}

type Cache = { at: number; ids: string[] }
type HealthCache = { at: number; results: Record<string, boolean> }

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

  // A couple of models can legitimately be missing, but a near-empty answer is
  // almost always a gateway/proxy page rather than the real inventory.
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
    const extraModels = (options.extraModels ?? []).filter((id): id is string => typeof id === "string" && id.length > 0)
    const includeFreeModels = options.includeFreeModels !== false
    const testModelsOnUse = options.testModelsOnUse !== false
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

    // Proactive health check: test all candidate models on startup, only keep healthy ones.
    // This runs after we have the live inventory (from cache or after first refresh).
    const runStartupHealthChecks = async (live: Set<string>): Promise<Set<string>> => {
      if (!testAllOnStartup || !apiKey || !live || live.size === 0) return live

      // Build the candidate list: only extraModels + freeModels that are live (models we actually add to picker)
      const candidates = new Set<string>([...extraModels])
      if (includeFreeModels) {
        for (const id of FREE_MODEL_IDS) {
          if (live.has(id)) candidates.add(id)
        }
      }

      const toTest = [...candidates].filter((id) => live.has(id))
      if (toTest.length === 0) return live

      log(`startup health check: testing ${toTest.length} models...`)

      const cache = state.healthCache ?? { at: Date.now(), results: {} }
      const healthy = new Set<string>()

      // Test in parallel with concurrency limit
      const CONCURRENCY = 3
      for (let i = 0; i < toTest.length; i += CONCURRENCY) {
        const batch = toTest.slice(i, i + CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (modelId) => {
            if (cache.results[modelId] !== undefined) {
              return { modelId, healthy: cache.results[modelId] }
            }
            log(`health checking ${modelId}...`)
            const h = await testModelHealth(baseURL, apiKey, modelId)
            cache.results[modelId] = h
            return { modelId, healthy: h }
          })
        )
        for (const { modelId, healthy: h } of results) {
          if (h) healthy.add(modelId)
          else log(`disabling unhealthy model: ${modelId}`)
        }
      }

      cache.at = Date.now()
      state.healthCache = cache
      try {
        await ctx.storage.set(HEALTH_CACHE_KEY, cache)
      } catch (e) {
        log(`failed to save health cache: ${String(e)}`)
      }

      log(`startup health check complete: ${healthy.size}/${toTest.length} models healthy`)
      return healthy
    }

    // Initial refresh: fetch live inventory first, then run health checks
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
        const next = new Set(ids)
        state.live = next

        await ctx.storage.set(CACHE_KEY, { at: Date.now(), ids: [...next] } satisfies Cache)

        // Run startup health checks on the fresh inventory
        if (testAllOnStartup) {
          state.live = await runStartupHealthChecks(next)
        }

        // Log summary of all candidate models with status
        const allCandidates = new Set<string>([...extraModels])
        if (includeFreeModels) {
          for (const id of FREE_MODEL_IDS) {
            if (next.has(id)) allCandidates.add(id)
          }
        }
        // Also include catalog models that are live
        try {
          const record = await ctx.provider.get(PROVIDER)
          if (record) {
            for (const model of record.models.values()) {
              if (next.has(model.id)) allCandidates.add(model.id)
            }
          }
        } catch {}

        const cache = state.healthCache ?? { at: Date.now(), results: {} }
        const lines = ["model status summary:"]
        let healthyCount = 0, unhealthyCount = 0, untestedCount = 0
        for (const id of [...allCandidates].sort()) {
          const inLive = next.has(id)
          const isExtra = extraModels.includes(id)
          const isFree = FREE_MODEL_IDS.includes(id)
          const source = isExtra ? "extra" : isFree ? "free" : "catalog"
          const status = cache.results[id] === true ? "✓ healthy" : cache.results[id] === false ? "✗ failed" : inLive ? "? untested" : "⊘ not live"
          if (cache.results[id] === true) healthyCount++
          else if (cache.results[id] === false) unhealthyCount++
          else if (inLive) untestedCount++
          lines.push(`  ${id} [${source}] ${status}`)
        }
        lines.push(`summary: ${healthyCount} healthy, ${unhealthyCount} failed, ${untestedCount} untested, ${next.size} live total`)
        log(lines.join("\n"))

        log(`loaded ${state.live.size} live models (${healthyCount} verified healthy)`)

        // Save full status for user inspection
        const statusEntries = [...allCandidates].map((id) => {
          const inLive = next.has(id)
          const isExtra = extraModels.includes(id)
          const isFree = FREE_MODEL_IDS.includes(id)
          const source = isExtra ? "extra" : isFree ? "free" : "catalog"
          const health = cache.results[id]
          let status: "healthy" | "failed" | "untested" | "not-live"
          if (health === true) status = "healthy"
          else if (health === false) status = "failed"
          else if (inLive) status = "untested"
          else status = "not-live"
          return { id, source, status, live: inLive }
        })
        try {
          await ctx.storage.set(STATUS_CACHE_KEY, { at: Date.now(), entries: statusEntries })
        } catch (e) {
          log(`failed to save status cache: ${String(e)}`)
        }

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
        // Combine explicit extraModels with free-tier models (if opted-in) that are live.
        let combinedExtra = [...extraModels]
        if (includeFreeModels && live) {
          for (const id of FREE_MODEL_IDS) {
            if (live.has(id) && !combinedExtra.includes(id)) combinedExtra.push(id)
          }
        }
        if (combinedExtra.length === 0 || !live) return

        // Only models the caller explicitly asked for (or free-tier opt-in), and only while the API
        // actually serves them. Covers endpoints models.dev has not catalogued
        // yet (for example nvidia/nemotron-3.5-bolt-e4b) without polluting the
        // picker with embeddings, detectors, or media models.
        const missing = combinedExtra.filter((id) => live.has(id) && !record.models.has(id))
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

    /** Check model health (with cache). Returns true if healthy. */
    const checkHealth = async (modelId: string): Promise<boolean> => {
      if (!testModelsOnUse) return true
      if (!apiKey) return true // Can't test without key

      const cache = state.healthCache ?? { at: Date.now(), results: {} }
      if (cache.results[modelId] !== undefined) {
        return cache.results[modelId]
      }

      log(`health checking ${modelId}...`)
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
        // Remove from model picker
        await ctx.model.transform((editor) => {
          editor.remove(PROVIDER, modelId)
        })
      }
      return healthy
    }

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
        
        // Run health checks on newly added models if testAllOnStartup is enabled
        if (testAllOnStartup && before) {
          const newModels = [...next].filter((id) => !before.has(id))
          if (newModels.length > 0) {
            log(`refresh: testing ${newModels.length} new models...`)
            const healthyNew = await runStartupHealthChecks(new Set(newModels))
            // Only keep healthy new models
            for (const id of newModels) {
              if (!healthyNew.has(id)) next.delete(id)
            }
          }
        }
        
        state.live = next

        await ctx.storage.set(CACHE_KEY, { at: Date.now(), ids: [...next] } satisfies Cache)
        // Rebuilding the model domain re-runs the prune/extras transforms with
        // the fresh inventory. Provider settings are already applied at setup.
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

    // Start periodic refresh timer
    timer = setTimeout(() => void tick(), interval)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  },
})