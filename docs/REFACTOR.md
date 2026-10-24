# Refactor plan

Written 2026-10-24 after a whole-repo audit. It says what the code is, which stack it should stay on, where it hurts, and in which order to fix that without a rewrite. Vocabulary follows `CONTEXT.md`.

## What the repo is

| Part | Size | State |
|------|------|-------|
| Core (`src/*.ts`: server, queue, store, torrent, indexer, catalogue, bindings, feed, publisher) | ~3 200 lines | Clean, well tested, stable interfaces. Leave alone. |
| Providers (`src/providers/`) | ~7 000 lines, 19 providers in 35 files | Where all the duplication and most bugs live. |
| Media pipeline (`src/media/`) | ~1 700 lines | Correct, but no request timeouts and a few untested paths. |
| Web UI (`web/`) | ~330 lines of app code + shadcn components | Fine. One API error-handling bug. |
| Tests | 172 tests, ~3.6 s | Core and parsing covered; HTTP resume, Oneplay pool, Nova paging are not. |

Load: one home instance, Sonarr and Radarr as clients, up to 32 concurrent downloads. Nothing here needs to scale beyond that.

## Stack: keep it

Every layer below does its job and a swap would cost more than it returns.

| Layer | Now | Verdict |
|-------|-----|---------|
| Runtime, package manager, test runner | Bun 1.4, `node:test` + `node:assert` | Keep. One tool, fast tests, `node:sqlite` built in. |
| Language | TypeScript 7, `strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `noEmit` (Bun runs `.ts` directly) | Keep exactly this. No build step for the service. |
| HTTP server | Fastify 5 + multipart + static | Keep. The API surface is two small protocols (Torznab, qBittorrent v2) and a handful of `/v1` routes. |
| Storage | SQLite via `node:sqlite`, JSON payload columns, hand-written migrations in `store.ts` | Keep. Four tables of JSON blobs do not need an ORM or a migration tool. |
| Upstream parsing | `cheerio`, `fast-xml-parser`, `json5`, `at()` dotted getter over `unknown` | Keep. Upstream HTML/JSON is untrusted and changes often; a schema library would only move the breakage. |
| JS evaluation | `quickjs-emscripten` (required by `youtubei.js` 18, which ships no evaluator) | Keep while YouTube stays a provider. |
| Media tools | ffmpeg and ffprobe via `spawn` arrays, Bento4 `mp4decrypt`, Widevine via remote CDM | Keep. |
| Web UI | React 19, Vite 8, Tailwind 4, shadcn/ui, TanStack Query 5 | Keep. 330 lines of app code is not worth a framework change. |
| CI | `docker build --target test` on a self-hosted runner | Keep. The ffmpeg download should move to a mirror the project controls (see phase 3). |

Do not do: a NestJS/Hono rewrite, Prisma or Drizzle, Zod on upstream payloads, a monorepo tool, Deno or Node, a plugin system for providers. None of them removes a bug from the list below.

## Where it hurts

Findings from the audit that a refactor should remove, not individually patch.

1. **Three ways to do one thing in providers.** Two `absUrl` with different behaviour (`nova-markiza-utils.ts:21` returns undefined, `public-sites.ts:30` throws); `loadHtml`/`select` wrappers around cheerio next to direct `cheerio.load` calls; `AbortSignal.any([signal, AbortSignal.timeout(45_000)])` around a bare `fetch` in 13 places although `fetchText` already does it; a second, weaker segment fetcher in `track-decrypt.ts:22`.
2. **Program lists are cached in some providers and refetched on every search in others.** `cached(PROGRAM_LIST_TTL_MS, …)` in Nova, TN, Voyo, JOJ; nothing in Prima zoom/CNN, PrimaDoma, Barrandov, Autosalon, Stream.cz cold discovery. `searchCatalogue` drains the whole list per text search, so the difference is 1 vs N upstream fetches per Sonarr batch.
3. **`SessionRejected` means two things.** In `account-session.ts` it means "the upstream refused this session, log in again". Prima (`prima.ts:249`, `:579`) and Webshare (`file-hosts.ts:124`) throw it for ordinary failures too, so a geo-blocked episode costs a new login and, at Prima, a new registered device.
4. **Two files hold several providers each.** `public-sites.ts` (776 lines) is seven providers plus the shared URL-resolver helper; `prima.ts` (630 lines) is three Prima sites plus the play API. Every edit touches unrelated providers.
5. **Media HTTP has no deadline.** `segment-download.ts`, `http-download.ts`, `m3u8.ts`, `track-decrypt.ts`, `metadata.ts` pass only the job's abort signal to `fetch` and read the body without an idle timer. A stalled server holds a download slot until someone pauses the job.
6. **Tables only grow.** `releases`, `release_first_seen`, `series_release_cache`, `stream_episode_cache` are never pruned. Harmless at home scale for years, but free to fix.
7. **Untested risky paths.** `http-download.ts` 206 resume and 200 restart; `OneplayConnectionPool` acquire/abort/close; Nova `mixed/more` paging; every timeout added in phase 3.

Already fixed in PR #7: MPD timeline bound, 416 resume completion, Oneplay 401 handling.

## Rules for the refactor

- The `Provider`, `Catalogue`, `Release` and `MediaSource` interfaces in `types.ts` do not change. `catalogue.ts`, `queue.ts`, `store.ts`, `torrent.ts`, `account-session.ts` and the bindings are not part of this refactor.
- Phases 1 and 2 change no behaviour. A phase is done when `bun run check`, `bun run test` and `bun run --cwd web typecheck` pass and the diff removes more lines than it adds.
- One PR per phase, smallest first. Tests from phase 0 land before the code they guard.
- No new abstraction unless it replaces at least two existing copies. No wrapper that only passes a call through.
- Keep the error texts users already see in logs and in Sonarr; several are referenced in `CHANGELOG.md`.

## Phases

### Phase 0: guardrails (tests only, ~150 lines)

| Test | File | Why first |
|------|------|-----------|
| 206 resume honoured, 200 after `Range` restarts without corrupting the file | `test/http-download.test.ts` (extend) | Phase 3 touches the same function. |
| Pool: aborted waiter leaves the queue, `close()` rejects queued callers, connections are released on error | `test/oneplay-pool.test.ts` (new; make the connection factory a constructor parameter) | Phase 2 changes the auth gate. |
| Nova `mixed/more` paging with a recorded fixture, including the `offset=-6` boundary | `test/nova-markiza.test.ts` (new) | Pins the episode numbering before `public-sites`-style splitting. |
| `fetchTextRetry` stops on abort and on 4xx | `test/nova-markiza.test.ts` | Phase 1 replaces the helper. |

### Phase 1: one helper per job (`src/providers/common.ts`, −~90 lines)

1. Add `fetchResponse(url, signal, init)`: the 45 s timeout and the `!ok` check that `fetchText` has, returning the `Response`. Make `fetchText` call it. Replace the 13 inline `AbortSignal.any([...timeout(45_000)])` calls (Voyo, SledovaniTV, Barrandov, YouTube, JOJ, Prima auth, Oneplay connection, Přehraj.to).
2. Move one `absUrl(base, href)` into `common.ts` (the throwing one; callers that want `undefined` wrap it). Delete the copy in `nova-markiza-utils.ts`.
3. Delete `loadHtml` and `select` in `nova-markiza-utils.ts`; import `load` from cheerio directly like ČT and Stream.cz do.
4. `fetchTextRetry`: stop retrying when `signal.aborted` or the error is `HTTP 4xx`.
5. Export `fetchSegment` from `segment-download.ts`; use it in `track-decrypt.ts` and delete the local copy.

### Phase 2: provider conventions (−~40 lines net, one file per provider)

1. Split `public-sites.ts` into `public-sites-primadoma.ts`, `-barrandov.ts` (merge with the existing helper file), `-autosalon.ts`, `-stvr.ts`, `-url-resolvers.ts` (html5, direct, youtube share `urlResolverRelease`). `public-sites.ts` keeps only `createPublicSiteProviders`. Pure move; `git log --follow` works on the pieces.
2. Split `prima.ts` by site the same way only if step 1 proved cheap; otherwise leave it.
3. Every provider's program list goes through `cached(PROGRAM_LIST_TTL_MS, …)`: Prima zoom and CNN, PrimaDoma, Barrandov, Autosalon. Stream.cz cold discovery shares its in-flight walk per scope the same way. TV-only providers return early on `query.kind === 'movie'`.
4. `SessionRejected` only for session refusals. Prima `prima.ts:249` throws `Error`; `prima.ts:579` maps only the play API codes that mean an invalid session (check against the upstream Java `PrimaPlus.API#getMedia`), the rest become `PrimaMessageError`. Webshare throws `SessionRejected` only on a token error code from `file_link`.
5. Oneplay `ensureAuthenticated`: remember the last successful probe time and skip the network probe for a minute; take the lock only on the login path.
6. SledovaniTV: persist `{deviceId, profileId, sessionId}` in the service database and seed the Account session from it, so a restart does not register a new device.
7. Record the conventions from 3 and 4 as `docs/adr/0002-provider-conventions.md`, three paragraphs.

### Phase 3: media deadlines and hygiene (~60 lines)

1. `fetchResponse`-style deadline on every media `fetch` and a per-chunk idle timer (60 s) in `chunks()` of `http-download.ts` and `writeSegmentBody` of `segment-download.ts`, so a stalled server falls into the existing retry loop. Test with a server that sends headers and then nothing.
2. Remove ffmpeg's `.tmp.` output on failure in `remux.ts` and `protected-media.ts` (`try/catch` + `rm`).
3. `extensionFromUrl` whitelist (`mp4|mkv|avi|mov|webm|ts|m4v`), else `mp4`.
4. Dockerfile: download ffmpeg from a release the project controls (mirror the BtbN tarballs to a GitHub release of this repo) so the pin stops rotting.

### Phase 4: store hygiene (~20 lines)

- `DELETE FROM series_release_cache WHERE created_at < ?` and `stream_episode_cache WHERE refreshed_at < ?` when writing; `releases` and `release_first_seen` older than, say, 90 days at startup. Jobs stay (Sonarr removes them).

## Out of scope

Deliberately not planned: provider plugin loading, a second storage backend, replacing `at()` with schemas, splitting the web UI into routes, moving the Vltava publisher out of the process, and anything in `catalogue.ts`.
