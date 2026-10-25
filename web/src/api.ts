/** The API key the UI signs in with; every request sends it. */
export const apiKey = {
  get: () => localStorage.getItem("apiKey") ?? "",
  set: (key: string) => localStorage.setItem("apiKey", key),
  clear: () => localStorage.removeItem("apiKey"),
}

/** Calls Bohemarr's JSON API under /v1. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/v1/${path}`, {
    method,
    headers: { "x-api-key": apiKey.get(), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // A restart or a proxy error page is not JSON; it is still an error with a status.
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`)
  return json
}

/** Pauses, resumes or removes Jobs through the qBittorrent API Sonarr and Radarr use. */
export async function jobAction(action: "pause" | "resume" | "delete", id: string): Promise<void> {
  const response = await fetch(`/api/v2/torrents/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey.get()}` },
    body: new URLSearchParams({ hashes: id, deleteFiles: "false" }),
  })
  if (!response.ok) throw new Error(await response.text())
}

export interface Setting {
  value?: string
  set: boolean
  source?: "env" | "ui"
}

export interface Settings {
  publicUrl: string
  categories: string[]
  providerIds: string[]
  enabled: string[]
  arrs: Record<string, { ok: boolean; message: string; at: string }>
  settings: Record<string, Setting>
}

export interface Job {
  id: string
  title: string
  provider: string
  category: string
  status: "Queued" | "Downloading" | "Paused" | "Completed" | "Failed"
  progress: number
  bytes: number
  totalBytes: number
  error: string
  createdAt: number
}

export interface SearchRelease {
  id: string
  title: string
  provider: string
  kind: "tv" | "movie"
  url: string
  publishedAt?: string
  size?: number
  sizeEstimated?: boolean
  height?: number
}
