import { useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LogOut, Pause, Play, RotateCw, Save, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api, apiKey, jobAction, type Job, type Settings } from "@/api"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/** Account providers and the settings each uses, as in .env.example. */
const ACCOUNTS: Record<string, string[]> = {
  iprima: ["USERNAME", "PASSWORD", "PROFILE", "DEVICE_ID"],
  oneplay: ["USERNAME", "PASSWORD", "ACCOUNT_ID", "PROFILE", "PROFILE_PIN"],
  markizavoyo: ["USERNAME", "PASSWORD", "COOKIES"],
  jojplay: ["USERNAME", "PASSWORD"],
  sledovanitv: ["USERNAME", "PASSWORD", "DEVICE_ID", "PROFILE", "COOKIES"],
  tvbarrandov: ["USERNAME", "PASSWORD"],
  youtube: ["CLIENT", "COOKIES", "PO_TOKEN", "VISITOR_DATA", "PLAYER_ID"],
}
const SECRET = /PASSWORD|API_KEY|PIN|TOKEN|COOKIES/

export function App() {
  const [signedIn, setSignedIn] = useState(Boolean(apiKey.get()))
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("GET", "settings"), enabled: signedIn, retry: false })

  if (!signedIn || settings.isError) {
    return <SignIn error={signedIn ? settings.error?.message : undefined} onSignIn={key => { apiKey.set(key); setSignedIn(true); void settings.refetch() }} />
  }
  if (!settings.data) return null
  return <Dashboard data={settings.data} onSignOut={() => { apiKey.clear(); setSignedIn(false) }} />
}

function SignIn({ error, onSignIn }: { error?: string; onSignIn: (key: string) => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Bohemarr</CardTitle>
          <CardDescription>Sign in with the API key: <code>docker compose exec bohemarr cat /config/api-key</code></CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={event => { event.preventDefault(); onSignIn(String(new FormData(event.currentTarget).get("key"))) }}>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <Label htmlFor="key">API key</Label>
            <Input id="key" name="key" type="password" required autoFocus />
            <Button type="submit">Sign in</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function Dashboard({ data, onSignOut }: { data: Settings; onSignOut: () => void }) {
  const queryClient = useQueryClient()
  const [changes, setChanges] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: () => api("PUT", "settings", changes),
    onSuccess: () => { setChanges({}); setSaved(true); toast.success("Saved. Restart to apply."); void queryClient.invalidateQueries({ queryKey: ["settings"] }) },
    onError: error => toast.error(error.message),
  })
  const restart = useMutation({
    mutationFn: () => api("POST", "restart"),
    onSuccess: () => { toast.info("Restarting…"); setSaved(false); setTimeout(() => location.reload(), 5000) },
    onError: error => toast.error(error.message),
  })

  const setting = (name: string) => data.settings[name] ?? { set: false }
  const value = (name: string) => changes[name] ?? setting(name).value ?? ""
  const change = (name: string, next: string) => setChanges({ ...changes, [name]: next })
  const field = (name: string, label: string) => {
    const { set, source } = setting(name)
    const secret = SECRET.test(name)
    return (
      <div className="grid gap-1.5" key={name}>
        <Label htmlFor={name}>{label}</Label>
        <Input id={name} type={secret ? "password" : "text"} value={value(name)} disabled={source === "env"}
          placeholder={source === "env" ? "set in .env" : secret && set ? "saved, type to replace" : ""}
          onChange={event => change(name, event.target.value)} />
      </div>
    )
  }
  const toggle = (name: string, label: string, fallback = "false") => (
    <div className="flex items-center gap-3">
      <Switch id={name} checked={["true", "1"].includes(value(name) || fallback)} disabled={setting(name).source === "env"}
        onCheckedChange={checked => change(name, String(checked))} />
      <Label htmlFor={name}>{label}</Label>
    </div>
  )
  const running = (id: string) => data.enabled.includes(id)
  const tbd = (id: string) => !running(id) && <Badge variant="outline">TBD</Badge>
  const enabled = value("PROVIDERS").split(",").map(id => id.trim()).filter(Boolean)
  const toggleProvider = (id: string) => change("PROVIDERS", (enabled.includes(id) ? enabled.filter(other => other !== id) : [...enabled, id]).join(","))

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Bohemarr</h1>
        {Object.keys(changes).length > 0 && <Button onClick={() => save.mutate()} disabled={save.isPending}><Save />Save</Button>}
        {saved && <Button variant="secondary" onClick={() => restart.mutate()} disabled={restart.isPending}><RotateCw />Restart to apply</Button>}
        <Button variant="ghost" size="icon" aria-label="Sign out" onClick={onSignOut}><LogOut /></Button>
      </header>

      <Tabs defaultValue="downloads" className="min-w-0">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="downloads">Downloads</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="arrs">Sonarr &amp; Radarr</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>

        <TabsContent value="downloads"><Downloads /></TabsContent>

        <TabsContent value="providers">
          <Section title="Providers" description={`${enabled.length ? "Only the checked providers are enabled." : "None checked: every public provider and every account provider with credentials is enabled."}${setting("PROVIDERS").source === "env" ? " Set in .env." : ""}`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {data.providerIds.map(id => (
                <div key={id} className={`flex items-center gap-2 ${running(id) ? "" : "opacity-50"}`}>
                  <Checkbox id={`provider-${id}`} checked={enabled.includes(id)} disabled={setting("PROVIDERS").source === "env"} onCheckedChange={() => toggleProvider(id)} />
                  <Label htmlFor={`provider-${id}`}>{id}</Label>{tbd(id)}
                </div>
              ))}
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="accounts">
          <Section title="Accounts" description="Credentials of the providers that need an account.">
            <Accordion type="multiple">
              {Object.entries(ACCOUNTS).map(([id, names]) => (
                <AccordionItem key={id} value={id}>
                  <AccordionTrigger className={running(id) ? "" : "opacity-50"}><span className="flex items-center gap-2">{id}{tbd(id)}</span></AccordionTrigger>
                  <AccordionContent className="grid gap-3 sm:grid-cols-2">
                    {names.map(name => field(`${id.toUpperCase()}_${name}`, name.toLowerCase().replaceAll("_", " ")))}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </Section>
        </TabsContent>

        <TabsContent value="arrs" className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            {["sonarr", "radarr"].map(app => {
              const status = data.arrs[app]
              const prefix = app.toUpperCase()
              return (
                <Section key={app} title={app[0]!.toUpperCase() + app.slice(1)}
                  badge={status && <Badge variant={status.ok ? "default" : "destructive"} title={status.message}>{status.ok ? "Connected" : "Setup failing"}</Badge>}
                  description={status && !status.ok ? status.message : "Bohemarr adds its indexer, download client, delay profile and root folder at every start."}>
                  <div className="grid gap-3">
                    {field(`${prefix}_URL`, "URL")}
                    {field(`${prefix}_API_KEY`, "API key")}
                    {field(`${prefix}_ROOT_FOLDER`, "Root folder")}
                    {field(`${prefix}_CATEGORY`, "Category")}
                  </div>
                </Section>
              )
            })}
          </div>
          <Section title="Imports">
            <div className="grid gap-3">
              {toggle("ARR_RENAME", "Rename imports with Bohemarr's naming formats (replaces Media Management naming)")}
              {toggle("ARR_REMOVE_COMPLETED", "Move completed downloads into the library and remove them", "true")}
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="general">
          <Section title="Downloads">
            <div className="grid gap-3 sm:grid-cols-2">
              {field("CATEGORIES", "Categories (comma-separated)")}
              {field("CONCURRENCY", "Simultaneous downloads (1–32)")}
            </div>
          </Section>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Section({ title, description, badge, children }: { title: string; description?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{title}{badge}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const STATUS_VARIANT = { Queued: "outline", Downloading: "secondary", Paused: "outline", Completed: "default", Failed: "destructive" } as const

function Downloads() {
  const queryClient = useQueryClient()
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api<Job[]>("GET", "jobs"), refetchInterval: 3000 })
  const act = useMutation({
    mutationFn: ({ action, id }: { action: "pause" | "resume" | "delete"; id: string }) => jobAction(action, id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: error => toast.error(error.message),
  })
  const list = [...(jobs.data ?? [])].reverse()

  return (
    <Section title="Downloads" description="Newest first; refreshes every 3 seconds. Removing a download keeps its files.">
      {list.length === 0 ? <p className="text-sm text-muted-foreground">No downloads yet.</p> : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>Release</TableHead><TableHead>Status</TableHead><TableHead className="w-40">Progress</TableHead><TableHead /></TableRow>
          </TableHeader>
          <TableBody>
            {list.map(job => (
              <TableRow key={job.id}>
                <TableCell className="max-w-xs whitespace-normal">
                  <div className="font-medium">{job.title}</div>
                  <div className="text-xs text-muted-foreground">{job.provider} · {job.category}{job.totalBytes > 0 && ` · ${(job.totalBytes / 1e9).toFixed(2)} GB`}</div>
                  {job.error && <div className="text-xs text-destructive">{job.error}</div>}
                </TableCell>
                <TableCell><Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge></TableCell>
                <TableCell><Progress value={job.status === "Completed" ? 100 : job.progress || (job.totalBytes ? (job.bytes / job.totalBytes) * 100 : 0)} /></TableCell>
                <TableCell className="text-right">
                  {["Queued", "Downloading"].includes(job.status) && <Button variant="ghost" size="icon" aria-label="Pause" onClick={() => act.mutate({ action: "pause", id: job.id })}><Pause /></Button>}
                  {job.status === "Paused" && <Button variant="ghost" size="icon" aria-label="Resume" onClick={() => act.mutate({ action: "resume", id: job.id })}><Play /></Button>}
                  <Button variant="ghost" size="icon" aria-label="Remove"
                    onClick={() => confirm(`Remove ${job.title}? Its files stay on disk.`) && act.mutate({ action: "delete", id: job.id })}><Trash2 /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}
