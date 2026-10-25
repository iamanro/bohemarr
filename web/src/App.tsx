import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  Download,
  KeyRound,
  Link2,
  ListChecks,
  Loader2,
  LogOut,
  Pause,
  Play,
  RotateCw,
  Search as SearchIcon,
  Settings2,
  Trash2,
  Tv,
  X,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { api, apiKey, jobAction, type Job, type SearchRelease, type Settings } from "@/api"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

/** Display names, as the providers name themselves; `account` marks the ones that need credentials to run. */
const PROVIDERS: Record<string, { name: string; account?: boolean }> = {
  ceskatelevize: { name: "Česká televize" },
  streamcz: { name: "Stream.cz" },
  iprima: { name: "iPrima", account: true },
  oneplay: { name: "Oneplay", account: true },
  novaplus: { name: "TV Nova" },
  tncz: { name: "TV Nova News" },
  markizaplus: { name: "Markíza" },
  markizavoyo: { name: "VOYO", account: true },
  jojplay: { name: "JOJ Play", account: true },
  sledovanitv: { name: "SledovaniTV", account: true },
  tvprimadoma: { name: "TV Prima Doma" },
  tvbarrandov: { name: "TV Barrandov", account: true },
  tvautosalon: { name: "TV Autosalon" },
  stvr: { name: "STVR (RTVS)" },
  html5: { name: "HTML5" },
  youtube: { name: "YouTube" },
  direct: { name: "Direct" },
  webshare: { name: "Webshare" },
  prehrajto: { name: "Přehraj.to" },
}
const providerName = (id: string) => PROVIDERS[id]?.name ?? id

interface FieldSpec {
  label: string
  help?: string
  advanced?: boolean
}
const USERNAME: FieldSpec = { label: "Username", help: "The e-mail or name you sign in with." }
const PASSWORD: FieldSpec = { label: "Password" }
/** Account providers and their settings, as documented in .env.example. */
const ACCOUNTS: Record<string, { note?: string; fields: Record<string, FieldSpec> }> = {
  iprima: {
    fields: {
      USERNAME,
      PASSWORD,
      PROFILE: { label: "Profile", help: "Profile name; the first profile when empty.", advanced: true },
      DEVICE_ID: { label: "Device ID", help: "A registered device; Prima picks one when empty.", advanced: true },
    },
  },
  oneplay: {
    fields: {
      USERNAME,
      PASSWORD,
      ACCOUNT_ID: {
        label: "Account ID",
        help: "For logins with several accounts; Oneplay picks one when empty.",
        advanced: true,
      },
      PROFILE: { label: "Profile", help: "Profile name; Oneplay picks one when empty.", advanced: true },
      PROFILE_PIN: { label: "Profile PIN", help: "Only for a PIN-protected profile.", advanced: true },
    },
  },
  markizavoyo: {
    fields: {
      USERNAME,
      PASSWORD,
      COOKIES: {
        label: "Session cookie",
        help: "A Voyo cookie containing votoken, used before logging in.",
        advanced: true,
      },
    },
  },
  jojplay: { fields: { USERNAME, PASSWORD } },
  sledovanitv: {
    fields: {
      USERNAME,
      PASSWORD,
      DEVICE_ID: {
        label: "Paired device ID",
        help: "Used before logging in with the username and password.",
        advanced: true,
      },
      PROFILE: { label: "Profile", help: "Profile name; the first profile when empty.", advanced: true },
      COOKIES: {
        label: "Session cookies",
        help: "A signed-in browser session, used before logging in.",
        advanced: true,
      },
    },
  },
  tvbarrandov: { fields: { USERNAME, PASSWORD } },
  webshare: { note: "Works without an account at free-user speed.", fields: { USERNAME, PASSWORD } },
  prehrajto: { note: "Works without an account at free-user speed.", fields: { USERNAME, PASSWORD } },
  youtube: {
    note: "Works without an account; a signed-in session is optional.",
    fields: {
      CLIENT: { label: "Client", help: "TV, ANDROID, WEB or IOS (the default)." },
      COOKIES: { label: "Session cookies", help: "A signed-in browser session.", advanced: true },
      PO_TOKEN: { label: "PO token", help: "Proof-of-origin token from the same session.", advanced: true },
      VISITOR_DATA: {
        label: "Visitor data",
        help: "The session's visitor data, sent with the PO token.",
        advanced: true,
      },
      PLAYER_ID: { label: "Player ID", help: "Pins a player version.", advanced: true },
    },
  },
}
const SECRET = /PASSWORD|API_KEY|PIN|TOKEN|COOKIES/
/** Effective defaults from .env.example, shown while a setting is empty. */
const DEFAULTS: Record<string, string> = {
  CATEGORIES: "tv,movies",
  CONCURRENCY: "2",
  REQUEST_RATE: "10",
  SONARR_CATEGORY: "tv",
  RADARR_CATEGORY: "movies",
}

const VIEWS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "jobs", label: "Jobs", icon: ListChecks },
  { id: "search", label: "Search", icon: SearchIcon },
  { id: "providers", label: "Providers", icon: Tv },
  { id: "accounts", label: "Accounts", icon: KeyRound },
  { id: "arrs", label: "Sonarr & Radarr", icon: Link2 },
  { id: "general", label: "General", icon: Settings2 },
]
/** The view a setting is edited in, for the unsaved-changes marker. */
function viewOf(name: string): string {
  if (name === "PROVIDERS") return "providers"
  if (/^(SONARR|RADARR|ARR|VLTAVA)_/.test(name)) return "arrs"
  if (["CATEGORIES", "CONCURRENCY", "REQUEST_RATE"].includes(name)) return "general"
  return "accounts"
}

/** The view named in the URL hash, so a view can be bookmarked and survives a reload. */
function useView(): [string, (view: string) => void] {
  const hash = useSyncExternalStore(
    notify => {
      addEventListener("hashchange", notify)
      return () => removeEventListener("hashchange", notify)
    },
    () => location.hash.slice(1),
  )
  const view = VIEWS.some(({ id }) => id === hash) ? hash : "jobs"
  return [view, next => (location.hash = next)]
}

export function App() {
  const [signedIn, setSignedIn] = useState(Boolean(apiKey.get()))
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<Settings>("GET", "settings"),
    enabled: signedIn,
    retry: false,
  })

  const refused = settings.error?.message === "Invalid API key"
  if (!signedIn || refused) {
    return (
      <SignIn
        error={signedIn ? settings.error?.message : undefined}
        onSignIn={async key => {
          apiKey.set(key)
          setSignedIn(true)
          // A refused key is not kept for the next visit.
          if ((await settings.refetch()).error?.message === "Invalid API key") apiKey.clear()
        }}
      />
    )
  }
  if (settings.isError) {
    // Bohemarr is restarting or unreachable; the stored key is fine.
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Bohemarr did not answer: {settings.error.message}. It may still be starting; check{" "}
            <code>docker compose logs bohemarr</code> if this persists.
          </AlertDescription>
        </Alert>
        <Button className="mt-3" variant="secondary" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    )
  }
  if (!settings.data) return null
  return (
    <Dashboard
      data={settings.data}
      onSignOut={() => {
        apiKey.clear()
        setSignedIn(false)
      }}
    />
  )
}

function SignIn({ error, onSignIn }: { error?: string; onSignIn: (key: string) => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Bohemarr</h1>
          </CardTitle>
          <CardDescription>
            Sign in with the API key: <code>docker compose exec bohemarr cat /config/api-key</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3"
            onSubmit={event => {
              event.preventDefault()
              onSignIn(String(new FormData(event.currentTarget).get("key")))
            }}
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Label htmlFor="key">API key</Label>
            <Input id="key" name="key" type="password" required autoFocus />
            <Button type="submit">Sign in</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

/** Polls until Bohemarr answers again after a restart, then reloads the page. */
async function waitForRestart() {
  await new Promise(resolve => setTimeout(resolve, 1500))
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await api("GET", "settings")
      return location.reload()
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  location.reload()
}

function Dashboard({ data, onSignOut }: { data: Settings; onSignOut: () => void }) {
  const queryClient = useQueryClient()
  const [view, setView] = useView()
  const [changes, setChanges] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const dirty = Object.keys(changes).length
  const save = useMutation({
    mutationFn: () => api("PUT", "settings", changes),
    onSuccess: () => {
      setChanges({})
      setSaved(true)
      void queryClient.invalidateQueries({ queryKey: ["settings"] })
    },
    onError: error => toast.error(error.message),
  })
  const restart = useMutation({
    mutationFn: () => api("POST", "restart"),
    onSuccess: () => void waitForRestart(),
    onError: error => toast.error(error.message),
  })
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api<Job[]>("GET", "jobs"), refetchInterval: 3000 })
  const active = jobs.data?.filter(job => ["Queued", "Downloading"].includes(job.status)).length ?? 0

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    addEventListener("beforeunload", warn)
    return () => removeEventListener("beforeunload", warn)
  }, [dirty])
  useEffect(() => {
    // "/" jumps to the search field from anywhere but a text field.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || (event.target as HTMLElement).closest("input, textarea, select")) return
      event.preventDefault()
      setView("search")
      setTimeout(() => document.getElementById("q")?.focus())
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [setView])
  const nav = useRef<HTMLElement>(null)
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [view])

  const setting = (name: string) => data.settings[name] ?? { set: false }
  const locked = (name: string) => setting(name).source === "env"
  const value = (name: string) => changes[name] ?? setting(name).value ?? ""
  const change = (name: string, next: string) => {
    setSaved(false)
    setChanges({ ...changes, [name]: next })
  }
  const field = (
    name: string,
    { label, help }: FieldSpec,
    input: { type?: string; min?: number; max?: number; placeholder?: string } = {},
  ) => {
    const { set } = setting(name)
    const secret = SECRET.test(name)
    const hint = locked(name) ? "Set in .env; change it there." : secret && set ? "Saved. Type to replace it." : help
    return (
      <div className="grid content-start gap-1" key={name}>
        <Label htmlFor={name}>{label}</Label>
        <Input
          id={name}
          type={secret ? "password" : (input.type ?? "text")}
          min={input.min}
          max={input.max}
          value={value(name)}
          disabled={locked(name)}
          placeholder={
            secret && set ? "••••••••" : (input.placeholder ?? (DEFAULTS[name] ? `${DEFAULTS[name]} (default)` : ""))
          }
          aria-describedby={hint ? `${name}-hint` : undefined}
          onChange={event => change(name, event.target.value)}
        />
        {hint && (
          <p id={`${name}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    )
  }
  const toggle = (name: string, label: string, fallback = "false") => (
    <div className="flex items-start gap-3">
      <Switch
        id={name}
        checked={["true", "1"].includes(value(name) || fallback)}
        disabled={locked(name)}
        onCheckedChange={checked => change(name, String(checked))}
      />
      <Label htmlFor={name} className="leading-snug">
        {label}
      </Label>
    </div>
  )
  const running = (id: string) => data.enabled.includes(id)
  const hasCredentials = (id: string) =>
    Object.keys(ACCOUNTS[id]?.fields ?? {}).some(field => setting(`${id.toUpperCase()}_${field}`).set)

  const arrState = (app: string) => {
    const status = data.arrs[app]
    if (status)
      return status.ok
        ? ({ label: "Connected", variant: "success" } as const)
        : ({ label: "Setup failing", variant: "destructive" } as const)
    if (setting(`${app.toUpperCase()}_URL`).set) return { label: "Restart to connect", variant: "warning" } as const
    return { label: "Not configured", variant: "outline" } as const
  }

  return (
    <div className="min-h-svh md:grid md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="sticky top-0 z-10 flex flex-col bg-sidebar text-sidebar-foreground md:h-svh">
        <div className="flex items-center gap-2 px-4 pt-3 md:pt-4">
          <h1 className="mr-auto text-base font-semibold tracking-tight text-sidebar-accent-foreground">Bohemarr</h1>
          <Button
            variant="ghost"
            size="icon"
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:size-11"
            aria-label="Sign out"
            onClick={() => (!dirty || confirm("Sign out and discard your unsaved changes?")) && onSignOut()}
          >
            <LogOut />
          </Button>
        </div>
        <nav
          ref={nav}
          aria-label="Sections"
          className="flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] px-2 py-2 md:flex-col md:overflow-visible md:py-3"
        >
          {VIEWS.map(({ id, label, icon: Icon }) => {
            const changed = Object.keys(changes).some(name => viewOf(name) === id)
            return (
              <a
                key={id}
                href={`#${id}`}
                aria-current={view === id ? "page" : undefined}
                className="flex min-h-11 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-primary aria-[current=page]:text-sidebar-accent-foreground md:min-h-9"
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
                {id === "jobs" && active > 0 && (
                  <span className="ml-auto rounded-sm bg-sidebar-primary px-1.5 text-xs text-sidebar-primary-foreground tabular-nums">
                    {active}
                  </span>
                )}
                {changed && (
                  <span className="ml-auto size-2 rounded-full bg-warning" title="Unsaved changes">
                    <span className="sr-only">(unsaved changes)</span>
                  </span>
                )}
              </a>
            )
          })}
        </nav>
        <dl className="mt-auto hidden gap-1.5 border-t border-sidebar-border px-4 py-3 text-xs md:grid">
          {["sonarr", "radarr"].map(app => {
            const state = arrState(app)
            return (
              <div key={app} className="flex items-center justify-between gap-2">
                <dt className="capitalize">{app}</dt>
                <dd className={STATE_TEXT[state.variant]}>{state.label}</dd>
              </div>
            )
          })}
          <div className="flex items-center justify-between gap-2">
            <dt>Providers</dt>
            <dd className="text-sidebar-accent-foreground tabular-nums">
              {data.enabled.length} of {data.providerIds.length} on
            </dd>
          </div>
        </dl>
      </aside>

      <main className={`grid max-w-5xl min-w-0 content-start gap-3 p-3 md:p-5 ${dirty || saved ? "pb-24" : ""}`}>
        {/* Every view stays mounted, so a search survives a visit to another view. */}
        <div hidden={view !== "jobs"}>
          <Jobs jobs={jobs.data ?? []} onSearch={() => setView("search")} />
        </div>
        <div hidden={view !== "search"}>
          <Search categories={data.categories} />
        </div>

        <div hidden={view !== "providers"}>
          <Providers
            ids={data.providerIds}
            running={running}
            hasCredentials={hasCredentials}
            list={value("PROVIDERS")}
            locked={locked("PROVIDERS")}
            onChange={next => change("PROVIDERS", next)}
            enabled={data.enabled}
          />
        </div>

        <div hidden={view !== "accounts"}>
          <Section
            title="Accounts"
            description="Credentials for providers that need an account. Saved passwords are never shown again."
          >
            <Accordion type="multiple">
              {Object.entries(ACCOUNTS).map(([id, { note, fields }]) => {
                const entries = Object.entries(fields)
                const basic = entries.filter(([, spec]) => !spec.advanced)
                const advanced = entries.filter(([, spec]) => spec.advanced)
                const prefix = id.toUpperCase()
                const state = running(id)
                  ? ({ label: "Active", variant: "success" } as const)
                  : hasCredentials(id)
                    ? ({ label: "Saved, not active", variant: "warning" } as const)
                    : PROVIDERS[id]?.account
                      ? ({ label: "No credentials", variant: "outline" } as const)
                      : ({ label: "Off", variant: "outline" } as const)
                return (
                  <AccordionItem key={id} value={id}>
                    <AccordionTrigger>
                      <span className="flex flex-1 items-center gap-2">
                        {providerName(id)}
                        <Badge variant={state.variant} className="ml-auto">
                          {state.label}
                        </Badge>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="grid gap-3">
                      {note && <p className="text-sm text-muted-foreground">{note}</p>}
                      {state.label === "Saved, not active" && (
                        <p className="text-sm text-muted-foreground">
                          Restart to apply saved credentials, or check that {providerName(id)} is enabled under{" "}
                          <a className="underline underline-offset-3" href="#providers">
                            Providers
                          </a>
                          .
                        </p>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {basic.map(([name, spec]) => field(`${prefix}_${name}`, spec))}
                      </div>
                      {advanced.length > 0 && (
                        <details className="group rounded-md border p-3">
                          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {advanced.map(([name, spec]) => field(`${prefix}_${name}`, spec))}
                          </div>
                        </details>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          </Section>
        </div>

        <div hidden={view !== "arrs"} className="grid gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            {["sonarr", "radarr"].map(app => {
              const status = data.arrs[app]
              const state = arrState(app)
              const prefix = app.toUpperCase()
              const name = app[0]!.toUpperCase() + app.slice(1)
              return (
                <Section
                  key={app}
                  title={name}
                  badge={
                    <Badge variant={state.variant} className="ml-auto">
                      {state.label}
                    </Badge>
                  }
                  description={`At every start Bohemarr adds its indexer, download client, delay profile and root folder to ${name}.`}
                >
                  <div className="grid gap-3">
                    {status && !status.ok && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          {status.message} Check the URL and API key, save, and restart.
                        </AlertDescription>
                      </Alert>
                    )}
                    {field(
                      `${prefix}_URL`,
                      {
                        label: "URL",
                        help: `As Bohemarr reaches ${name}; in the same Compose network, its service name.`,
                      },
                      { type: "url", placeholder: `e.g. http://${app}:${app === "sonarr" ? 8989 : 7878}` },
                    )}
                    {field(`${prefix}_API_KEY`, { label: "API key", help: `${name}: Settings > General > Security.` })}
                    {field(
                      `${prefix}_ROOT_FOLDER`,
                      { label: "Root folder", help: `Optional. The library path as ${name} sees it.` },
                      { placeholder: app === "sonarr" ? "e.g. /data/media/tv" : "e.g. /data/media/movies" },
                    )}
                    {field(`${prefix}_CATEGORY`, {
                      label: "Category",
                      help: `One of the categories under General; ${name} downloads into it.`,
                    })}
                  </div>
                </Section>
              )
            })}
          </div>
          <Section title="Imports">
            <div className="grid gap-3">
              {toggle("ARR_RENAME", "Rename imports with Bohemarr's naming formats (replaces Media Management naming)")}
              {toggle(
                "ARR_REMOVE_COMPLETED",
                "Move completed Jobs into the library and remove them from Bohemarr",
                "true",
              )}
            </div>
          </Section>
          <Section
            title="Vltava"
            description="Uploads files Sonarr and Radarr import from listed providers to the Vltava tracker. Publishing is set up in .env (see .env.example); only the API token can be entered here."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {field("VLTAVA_TOKEN", {
                label: "API token",
                help: "A personal token with the upload scope, from your Vltava profile (Profil > API tokeny).",
              })}
            </div>
          </Section>
        </div>

        <div hidden={view !== "general"}>
          <Section title="Download client">
            <div className="grid gap-3 sm:grid-cols-2">
              {field("CATEGORIES", {
                label: "Categories",
                help: "Comma-separated download-client categories Sonarr and Radarr may use.",
              })}
              {field("CONCURRENCY", { label: "Simultaneous Jobs", help: "1–32." }, { type: "number", min: 1, max: 32 })}
              {field(
                "REQUEST_RATE",
                { label: "Requests per second to one service", help: "1–100; lower it if a service blocks Bohemarr." },
                { type: "number", min: 1, max: 100 },
              )}
            </div>
          </Section>
        </div>
      </main>

      {(dirty > 0 || saved) && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 px-3 py-2 backdrop-blur md:left-52"
        >
          <div className="flex max-w-5xl flex-wrap items-center gap-2 md:px-2">
            <p className="mr-auto text-sm" aria-live="polite">
              {dirty > 0
                ? `${dirty} unsaved ${dirty === 1 ? "change" : "changes"}`
                : "Saved. Restart Bohemarr to apply the changes."}
            </p>
            {dirty > 0 ? (
              <>
                <Button variant="ghost" className="max-md:h-11" onClick={() => setChanges({})}>
                  Discard
                </Button>
                <Button className="max-md:h-11" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                  Save
                </Button>
              </>
            ) : (
              <Button className="max-md:h-11" onClick={() => restart.mutate()} disabled={restart.isPending}>
                <RotateCw className={restart.isPending || restart.isSuccess ? "animate-spin" : ""} />
                {restart.isSuccess ? "Restarting…" : "Restart now"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const STATE_TEXT = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  outline: "text-sidebar-foreground",
} as const

function Section({
  title,
  description,
  badge,
  action,
  children,
}: {
  title: string
  description?: string
  badge?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <h2>{title}</h2>
          {badge}
          {action && <div className="ml-auto">{action}</div>}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Providers({
  ids,
  enabled,
  running,
  hasCredentials,
  list,
  locked,
  onChange,
}: {
  ids: string[]
  enabled: string[]
  running: (id: string) => boolean
  hasCredentials: (id: string) => boolean
  list: string
  locked: boolean
  onChange: (next: string) => void
}) {
  const chosen = list
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
  const automatic = chosen.length === 0
  const toggle = (id: string) =>
    onChange((chosen.includes(id) ? chosen.filter(other => other !== id) : [...chosen, id]).join(","))
  const group = (title: string, members: string[]) => (
    <fieldset className="grid gap-1">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{title}</legend>
      <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
        {members.map(id => {
          const needsAccount = !running(id) && PROVIDERS[id]?.account && !hasCredentials(id)
          return (
            <div key={id} className="flex min-h-9 items-center gap-2">
              <Checkbox
                id={`provider-${id}`}
                checked={automatic ? running(id) : chosen.includes(id)}
                disabled={locked || automatic}
                onCheckedChange={() => toggle(id)}
              />
              <Label htmlFor={`provider-${id}`}>{providerName(id)}</Label>
              {needsAccount ? (
                <a href="#accounts" className="ml-auto text-xs text-warning underline-offset-3 hover:underline">
                  Needs account
                </a>
              ) : (
                <span className={`ml-auto text-xs ${running(id) ? "text-success" : "text-muted-foreground"}`}>
                  {running(id) ? "On" : "Off"}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </fieldset>
  )

  return (
    <Section
      title="Providers"
      description={`The streaming services Bohemarr searches. "On" is the state since the last start.${locked ? " Set in .env; change it there." : ""}`}
    >
      <div className="grid gap-4">
        <div className="flex items-start gap-3">
          <Switch
            id="providers-automatic"
            checked={automatic}
            disabled={locked}
            onCheckedChange={checked => onChange(checked ? "" : enabled.join(","))}
          />
          <Label htmlFor="providers-automatic" className="grid gap-0.5 leading-snug">
            Use every available provider
            <span className="text-xs font-normal text-muted-foreground">
              Every public provider, and every account provider with credentials. Turn off to choose providers.
            </span>
          </Label>
        </div>
        {group(
          "Public",
          ids.filter(id => !PROVIDERS[id]?.account),
        )}
        {group(
          "Need an account",
          ids.filter(id => PROVIDERS[id]?.account),
        )}
      </div>
    </Section>
  )
}

const STATUS_VARIANT = {
  Queued: "outline",
  Downloading: "default",
  Paused: "warning",
  Completed: "success",
  Failed: "destructive",
} as const

function Jobs({ jobs, onSearch }: { jobs: Job[]; onSearch: () => void }) {
  const queryClient = useQueryClient()
  const act = useMutation({
    mutationFn: ({ action, id }: { action: "pause" | "resume" | "delete"; id: string }) => jobAction(action, id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: error => toast.error(error.message),
  })
  const list = [...jobs].reverse()
  const completed = jobs.filter(job => job.status === "Completed")

  return (
    <Section
      title="Jobs"
      description="Newest first; refreshes every 3 seconds. Removing a Job keeps its files."
      action={
        completed.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              confirm(
                `Remove ${completed.length} completed ${completed.length === 1 ? "Job" : "Jobs"}? Their files stay on disk.`,
              ) && completed.forEach(job => act.mutate({ action: "delete", id: job.id }))
            }
          >
            <Trash2 />
            Clear completed
          </Button>
        )
      }
    >
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Jobs yet. Sonarr and Radarr create them when they grab a Release, or{" "}
          <button type="button" className="text-primary underline-offset-3 hover:underline" onClick={onSearch}>
            search
          </button>{" "}
          and download one yourself.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Release</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32 max-sm:hidden">Progress</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map(job => {
              const percent =
                job.status === "Completed"
                  ? 100
                  : Math.min(100, job.progress || (job.totalBytes ? (job.bytes / job.totalBytes) * 100 : 0))
              return (
                <TableRow key={job.id}>
                  <TableCell className="max-w-xs whitespace-normal">
                    <div className="font-medium">{job.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {providerName(job.provider)} · {job.category}
                      {job.totalBytes > 0 && ` · ${(job.totalBytes / 1e9).toFixed(2)} GB`}
                    </div>
                    {job.error && <div className="text-xs text-destructive">{job.error}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
                  </TableCell>
                  <TableCell className="max-sm:hidden">
                    <div className="flex items-center gap-2">
                      <Progress value={percent} aria-label={`${Math.round(percent)} %`} />
                      <span className="w-9 text-right text-xs text-muted-foreground">{Math.round(percent)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {["Queued", "Downloading"].includes(job.status) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="max-md:size-11"
                        aria-label={`Pause ${job.title}`}
                        onClick={() => act.mutate({ action: "pause", id: job.id })}
                      >
                        <Pause />
                      </Button>
                    )}
                    {job.status === "Paused" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="max-md:size-11"
                        aria-label={`Resume ${job.title}`}
                        onClick={() => act.mutate({ action: "resume", id: job.id })}
                      >
                        <Play />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="max-md:size-11"
                      aria-label={`Remove ${job.title}`}
                      onClick={() =>
                        confirm(`Remove ${job.title}? Its files stay on disk.`) &&
                        act.mutate({ action: "delete", id: job.id })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

/** A native select styled as an Input; the UI kit has no Select. */
const SELECT = "h-8 rounded-md border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"

function Search({ categories }: { categories: string[] }) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState<Record<string, string>>({ t: "search" })
  const [category, setCategory] = useState("")
  const [results, setResults] = useState<{ releases: SearchRelease[]; total: number }>()
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const abort = useRef<AbortController>(null)
  const search = useMutation({
    mutationFn: (offset: number) => {
      abort.current = new AbortController()
      return api<{ releases: SearchRelease[]; total: number }>(
        "GET",
        `search?${new URLSearchParams({ ...query, offset: String(offset) })}`,
        undefined,
        abort.current.signal,
      )
    },
    onSuccess: (page, offset) =>
      setResults({
        total: page.total,
        releases: offset ? [...(results?.releases ?? []), ...page.releases] : page.releases,
      }),
    onError: error => error.name !== "AbortError" && toast.error(error.message),
  })
  const download = useMutation({
    mutationFn: (release: SearchRelease) => api("POST", "jobs", { release: release.id, ...(category && { category }) }),
    onMutate: release => setQueued(previous => new Set(previous).add(release.id)),
    onSuccess: (_job, release) => {
      toast.success(`Queued ${release.title}`)
      void queryClient.invalidateQueries({ queryKey: ["jobs"] })
    },
    onError: (error, release) => {
      setQueued(previous => {
        const next = new Set(previous)
        next.delete(release.id)
        return next
      })
      toast.error(error.message)
    },
  })
  const set = (name: string, value: string) => setQuery({ ...query, [name]: value })
  const tv = query.t === "tvsearch"
  const dated = results?.releases.some(release => release.publishedAt)

  return (
    <Section
      title="Search"
      description="Searches every enabled provider, as Sonarr and Radarr do, and inspects each result, which can take a minute. Sonarr and Radarr may import a Job in their category."
    >
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={event => {
          event.preventDefault()
          search.mutate(0)
        }}
      >
        <div className="grid min-w-48 flex-1 gap-1">
          <Label htmlFor="q">Title or URL</Label>
          <Input id="q" value={query.q ?? ""} required onChange={event => set("q", event.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="t">Type</Label>
          <select
            id="t"
            className={SELECT}
            value={query.t}
            onChange={event => setQuery({ q: query.q ?? "", t: event.target.value })}
          >
            <option value="search">Series or movie</option>
            <option value="tvsearch">Series</option>
            <option value="movie">Movie</option>
          </select>
        </div>
        {tv && (
          <>
            <div className="grid w-20 gap-1">
              <Label htmlFor="season">Season</Label>
              <Input
                id="season"
                type="number"
                min={0}
                value={query.season ?? ""}
                onChange={event => set("season", event.target.value)}
              />
            </div>
            <div className="grid w-20 gap-1">
              <Label htmlFor="ep">Episode</Label>
              <Input
                id="ep"
                type="number"
                min={0}
                value={query.ep ?? ""}
                onChange={event => set("ep", event.target.value)}
              />
            </div>
          </>
        )}
        <div className="grid gap-1">
          <Label htmlFor="category">Download to</Label>
          <select id="category" className={SELECT} value={category} onChange={event => setCategory(event.target.value)}>
            <option value="">Automatic (by type)</option>
            {categories.map(name => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </div>
        {search.isPending ? (
          <Button type="button" variant="outline" className="w-28" onClick={() => abort.current?.abort()}>
            <X />
            Cancel
          </Button>
        ) : (
          <Button type="submit" className="w-28">
            <SearchIcon />
            Search
          </Button>
        )}
      </form>
      <p aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
        {search.isPending ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Searching every enabled provider…
          </span>
        ) : (
          results && (results.releases.length === 0 ? "Nothing found." : `${results.total} found.`)
        )}
      </p>
      {results && results.releases.length > 0 && (
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>Release</TableHead>
              {dated && <TableHead className="max-sm:hidden">Published</TableHead>}
              <TableHead>
                <span className="sr-only">Download</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.releases.map(release => (
              <TableRow key={release.id}>
                <TableCell className="max-w-md whitespace-normal">
                  <a className="font-medium hover:underline" href={release.url} target="_blank" rel="noreferrer">
                    {release.title}
                  </a>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary">{release.kind === "tv" ? "Series" : "Movie"}</Badge>
                    {release.height ? <Badge variant="outline">{release.height}p</Badge> : null}
                    {providerName(release.provider)}
                    {release.size ? ` · ${release.sizeEstimated ? "~" : ""}${(release.size / 1e9).toFixed(2)} GB` : ""}
                  </div>
                </TableCell>
                {dated && (
                  <TableCell className="text-sm max-sm:hidden">
                    {release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : ""}
                  </TableCell>
                )}
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="max-md:size-11"
                    aria-label={queued.has(release.id) ? `Queued ${release.title}` : `Download ${release.title}`}
                    disabled={queued.has(release.id)}
                    onClick={() => download.mutate(release)}
                  >
                    {queued.has(release.id) ? <Check className="text-success" /> : <Download />}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {results && results.releases.length < results.total && (
        <Button
          className="mt-3"
          variant="secondary"
          disabled={search.isPending}
          onClick={() => search.mutate(results.releases.length)}
        >
          {search.isPending ? "Loading…" : `More (${results.releases.length} of ${results.total})`}
        </Button>
      )}
    </Section>
  )
}
