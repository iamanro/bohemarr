# Changelog

## 2026-10-05

### Publishing imports to Vltava

- Bohemarr can upload what Sonarr and Radarr import to the Vltava tracker and seed it with a dedicated [rqbit](https://github.com/ikatson/rqbit) server. Only Bohemarr downloads from providers in `VLTAVA_PROVIDERS` are published, as single episodes or movies with a TMDB ID. Each upload carries the episode, resolution, type WEB-DL and a Markdown description with the source and TMDB/TVDB/IMDb links, and waits in Vltava's moderation queue unless the account may skip it.
- Sonarr and Radarr report imports through a Webhook connection (`POST /hooks/arr`), which Bohemarr creates with the rest of their setup and removes when publishing is off. Bohemarr keeps the Release of each download after Sonarr or Radarr removes it, because an import can be reported after its download is gone.
- Uploads go through Vltava's `vltava` CLI, so canonical naming, MediaInfo and the `.torrent` follow Vltava's own rules. `compose.vltava.yaml` builds the CLI into the image from `VLTAVA_SOURCE`, mounts the library at `MEDIA_DIR` and runs rqbit 9.0.1 as `vltava-seeder` (DHT, LSD and UPnP off, fast resume on). A publication counts as seeding once rqbit verified every piece; a tree that does not match its torrent fails, and rqbit lets go of it so it never downloads. Publications are stored in SQLite and survive restarts. A failed step is retried after 5 minutes, doubling up to 6 hours, and gives up after 8 attempts; a torrent Vltava already has is not retried. The API token reaches the CLI through its environment, never its arguments.
- The bundled `vltava-seeder` runs only with `COMPOSE_PROFILES=seeder`. Otherwise `VLTAVA_SEEDER_URL` points to the rqbit Vltava's community seedbox runs, and Vltava's staff page `/seedbox` manages the publications as foreign torrents. `VLTAVA_OUT_DIR` must stay outside Vltava's `SEEDBOX_SAVE_PATH`.
- Requires Vltava with the `vltava` CLI and `POST /naming/plan`, which production does not run yet (it runs d413155), and its torrent descriptions rendered as Markdown (local Vltava change).
- Verified end to end against a local Vltava (separate database, Meilisearch and Redis prefix), Sonarr and the Compose stack: Sonarr grabbed an episode from Bohemarr and imported it, and the webhook queued it. The CLI in the image uploaded it into moderation. rqbit verified all of the hardlinked tree (`live`, finished), the tracker counted it as a seeder once a moderator approved it, and after a restart rqbit resumed without hashing the files again. That run showed rqbit cannot seed from a read-only mount, because it opens files read/write.

### Fix: a download could crash the whole service

- Bohemarr exited with `AssertionError: assert(!this.paused)` when a server closed the connection while a download was still writing earlier data to disk. The download smoke test against Python's `http.server` hit this every time; it is intermittent over real networks.
- Cause: cheerio imports undici 7.30, and that import makes undici 7 the HTTP stack of Node's global `fetch`, in place of the undici 8.10 that Node 26 bundles. Undici 7 asserts when the connection ends while its parser is paused for backpressure, and that assertion cannot be caught ([nodejs/undici#5360](https://github.com/nodejs/undici/issues/5360)). Undici 8.11 drains the parser instead, and 7.30 is the newest 7.x release.
- `package.json` now overrides every undici in the dependency tree to `^8.11.2`. A regression test reproduces the upstream case with the providers loaded as in the service; it failed before the override and passes with it. The same download from `http.server` that crashed now completes five times out of five.

### Configuration in .env and automatic Sonarr/Radarr setup

- Every single-value setting is an environment variable, set in `.env`, which `compose.yaml` passes to the container; `.env.example` documents each one. `PROVIDERS` lists exactly the enabled providers, provider settings are named `<PROVIDER>_<SETTING>` (for example `ONEPLAY_PASSWORD`, `ONEPLAY_PROFILE_PIN`, `YOUTUBE_PO_TOKEN`), and `CATEGORIES` sets the download-client categories.
- Any variable can be read from a file named by `NAME_FILE`, for example a Docker secret, so passwords and API keys need not appear in `docker inspect`.
- **Breaking:** `config.json` now holds only the provider settings that are lists or objects: `providers.<id>.catalog` and `providers.<id>.headers`. Bohemarr refuses to start when it contains anything else, such as credentials, `enabled`, `categories` or `concurrency`, and names the variable to use instead. Without `PROVIDERS`, every public provider is enabled, and every account provider whose credentials are set.
- With `SONARR_URL`/`SONARR_API_KEY` or `RADARR_URL`/`RADARR_API_KEY`, Bohemarr configures the application at every start: a qBittorrent download client and a Torznab indexer named Bohemarr (the indexer sends its grabs to that client), a Delay Profile without torrent delay for the tag `bohemarr`, and the root folder from `SONARR_ROOT_FOLDER`/`RADARR_ROOT_FOLDER`. `ARR_REMOVE_COMPLETED` sets Remove Completed. An unreachable application is retried with growing intervals of up to ten minutes.
- **Breaking:** the state directory moved from `/data` to `/config`; the Compose `config` volume keeps its contents. Containers started without Compose must mount their state volume at `/config`.
- `DOWNLOADS_DIR` sets the downloads path inside the container, so it can match the path Sonarr and Radarr use (for example `/data/downloads`) without a Remote Path Mapping. `PUBLISH_ADDRESS` and `PUBLISH_PORT` set the published host address and port.
- Verified with Docker Compose against Sonarr and Radarr containers. Both were configured on the first start. A restart after changing `ARR_REMOVE_COMPLETED` and the Delay Profile in Sonarr created no duplicates and restored the `.env` values. A Sonarr that was down at startup was configured once it came up.

## 2026-10-04

### Torznab and qBittorrent instead of Newznab and SABnzbd

- **Breaking:** Bohemarr now presents itself as a Torznab indexer at `/api` and a qBittorrent download client (Web API v2) instead of Newznab at `/newznab/api` and SABnzbd. Replace both entries in Sonarr and Radarr: a Torznab indexer with API Path `/api`, and a qBittorrent client with any username and the API key as password. Jobs added through SABnzbd remain in the queue, but Sonarr and Radarr no longer track them.
- A Task descriptor is now a signed .torrent with one placeholder byte; its info hash is the Job ID and the download ID Sonarr and Radarr track. Torznab items carry the same `infohash`. Re-adding a known task torrent returns the existing Job and requeues it only if it failed.
- A completed Job is reported as a finished torrent whose seeding goal is reached. Sonarr and Radarr then move and remove it when Remove Completed is enabled, and copy or hardlink it and leave it in place otherwise.
- Sonarr and Radarr never run failed-download handling for qBittorrent. A failed Job stays in their queue as a warning and is not blocklisted automatically.
- qBittorrent has no global pause or job priorities, so both are removed. On upgrade, a global pause becomes a pause of each Job it held back; jobs that bypassed it with force priority keep running.
- Delay Profiles now apply the Torrent delay to Bohemarr releases instead of the Usenet delay.
- Verified against Sonarr 4.0.20: the indexer and download-client tests passed. Two grabs downloaded, and Sonarr computed the same info hash as the Torznab item. With Remove Completed enabled, Sonarr moved the episode and removed the download. With it disabled, Sonarr hardlinked the episode (one inode, two links) and left the download in place.

## 2026-10-03

### Sonarr RSS feed for newly available episodes

- Found that Sonarr never grabbed newly available Love Island episodes automatically. Every Bohemarr grab was an interactive search, because the Bohemarr indexer had RSS and Automatic Search disabled. Bohemarr's RSS response was also unusable: it listed the first five catalogue programs alphabetically, all dated 1970, and took 22 seconds.
- The TV RSS feed (`t=tvsearch` without a query) now lists the five newest episodes of each watched series, newest first, with the TVDB ID and canonical title of bound series. A series becomes watched when Sonarr first searches it by TVDB ID, and it stays watched. Series already searched before the upgrade are watched automatically.
- The feed never creates a Series binding. Items are dated when first listed, and that date is stored so it does not change. One listing is shared for ten minutes, and each item's playback inspection is reused for six hours. A failed listing is not cached. While no series is watched, the previous catalogue browse response remains.
- Order Oneplay episodes by season and episode number, newest first. Love Island and Extractors list their season tabs newest-first, so the previous tab reversal put season 1 first.
- Keep a download queued when Oneplay refuses playback because every concurrent stream of the account is in use (code 4091). Previously this failed immediately with "Provider returned no playable media". Sonarr then blocklisted the episode's only release, and with the new fixed RSS dates it would never have grabbed that release again. Bohemarr now retries every five minutes and fails after twelve hours. The queue shows the provider's message.
- Deployment: enabled RSS and Automatic Search for the Bohemarr indexer in Sonarr. Added a `bohemarr` tag with a zero Usenet-delay Delay Profile to Love Island and Extractors, because the default six-hour delay held RSS grabs. The first RSS sync grabbed the missing Extractors S02E05 and S02E06 automatically.

### Radarr TMDB movie matching

- Accept and advertise `tmdbid` on Newznab movie searches.
- Use a verified local `catalogue_tmdb_mappings` movie binding to select the provider Program; when no binding exists, retain the title-and-year search fallback.
- Return the requested TMDB ID on matching releases so Radarr can associate them with its movie.

## 2026-09-30

### Archive search and downloads

- Publish actual video resolution, audio language and media size in Newznab releases. Adaptive-stream sizes are explicitly marked as estimates.
- Select the highest available video rendition by resolution and bitrate, with Czech audio preferred, for both search metadata and downloads.
- Preserve movie production years from Prima+ and Česká televize metadata. Radarr title-and-year searches reject conflicting or unknown source years rather than relabelling a sequel.
- Renew a rejected Prima account session and retry the affected request once; unrelated failures are not retried as authentication failures.
- Resolve localized series names through verified external identities: Skyhook supplies the TVDB identity and linked TMDB TV ID; TVmaze local names and alternate names are accepted only after verifying the linked TVDB ID.
- Persist the nullable TMDB TV ID in `series_mappings`, migrating existing databases without reassigning stored bindings. Movie and TV TMDB IDs remain distinct namespaces.
- Limit Newznab pages to five results, retaining `offset` pagination, to bound live playback-metadata inspection for account-enabled catalogues.

### SQLite-first series discovery

- Cache successful exact-episode lookups for verified Oneplay and Prima+ series bindings in SQLite for six hours, preserving canonical titles, provider ownership and paging. Empty results are not cached.
- Persist complete Stream.cz programme snapshots per TV/movie/unrestricted scope for six hours. Interrupted or malformed discovery cannot publish a partial or false-empty snapshot; cached programme ordering and source URLs are preserved.
- Reuse both caches after restart. Playback URLs, credentials, video quality and size remain live; downloads still resolve the source independently.
- Verified cached Extractors discovery at 6 ms on Oneplay and 18 ms on Stream.cz, compared with 2.56 s and 4.08 s respectively before the change. Catalogue HTTP calls to both sources dropped to zero on a cache hit.
- The actual Newznab service returned the correct 1080p release in 433–653 ms across three warm searches. Sonarr accepted it without rejection, but its full search operation still took 4–6 seconds; those timings are not presented as sub-second Sonarr searches.
- Type checking and build passed; all 124 tests passed in Docker, including cache expiry, persistence, query isolation, cancellation and incomplete-discovery regressions.

### Love Island interactive-search diagnosis

- Found Stream.cz's broad title fallback expanding unrelated programmes such as *Mazlové* (971 episodes), including repeated appearances of the same programme. The existing programme cache did not cache episode listings.
- Persist complete, non-empty Stream.cz episode listings in `stream_episode_cache` for five minutes, sharing a native programme's listing across requested episodes and repeated appearances without changing title matching or provider context. Playback stays live. First lookups and expired snapshots still scan upstream; newly published episodes can lag by five minutes.
- Guard cancellation, partial consumption and pagination completeness before publishing an episode snapshot. All 127 tests passed in Docker; type checking and build passed.
- Verified the same Love Island S04E45/S04E48 releases remained accepted by Sonarr at 1080p. A warm direct Bohemarr request took 1.19 seconds; an expired-cache request took 4.99 seconds.
- The full Sonarr interactive searches still took 6.16 and 8.00 seconds. Prowlarr history showed four Nyaa title variants spaced two seconds apart, returning no results. The five-indexer search is not claimed fixed by Bohemarr caching; other indexers and their search settings were left unchanged.

### Selected Sonarr interactive-search policy

- At the user's selection, disabled Nyaa interactive search in Sonarr only; RSS and automatic search remain enabled. Other Sonarr indexers remain available.
- Switched Sonarr's Prowlarr application to Add/Remove Only so existing Sonarr indexer settings stay local. Radarr remains on Full Sync and its Nyaa interactive search remains enabled.
- Ran a normal Prowlarr application/indexer synchronization and confirmed the Sonarr-only exclusion survived. Sonarr reported four active interactive indexers; Prowlarr recorded no Nyaa queries for the subsequent manual searches.
- The final Love Island S04E48 interactive search completed in 4.67 seconds with an accepted 1080p release. This improves the reported 7–8-second operation but is not an instant-search guarantee; other indexers and expired discovery caches still add latency.

### One-off deployment data operation

The catalogue matching pass is a completed deployment operation, **not a committed database dump or a new automatic synchronization feature**.

- Examined 21,015 category occurrences across the four enabled sources, corresponding to 16,967 unique `(provider, source_id)` catalogue entries.
- Stored 4,716 verified TMDB relations: 4,225 movie relations and 491 TV relations, representing 3,716 distinct TMDB movies and 467 distinct TMDB TV series.
- Recorded all entries, including unmatched entries and their reasons, in the production SQLite table `catalogue_tmdb_mappings`.

| Source | Verified TMDB relations | Without a verified relation |
| --- | ---: | ---: |
| Prima | 1,945 | 2,771 |
| Oneplay | 1,775 | 688 |
| Česká televize | 996 | 7,314 |
| Stream.cz | 0 | 1,478 |
| **Total** | **4,716** | **12,251** |

- Added 487 verified series bindings to the existing Sonarr matching table; four bindings already existed and no existing binding was reassigned.
- Accepted additional localized names from TMDB movie metadata and verified, typed TMDB TV pages. Names were not guessed or translated automatically.
- Left 12,251 entries without a verified relation: 5,660 lack a source production year; 4,950 have no exact title-and-year match; 1,491 fail the verified TV title/year/country criteria; 71 have ambiguous identities; 38 have conflicting source metadata; 21 have external metadata lookup/verification errors; and 20 lack a source country.
- Created a private pre-operation SQLite backup. Database snapshots, account credentials and temporary collectors are not committed to the repository.

### Archive deployment cutover

- Retired czarr as an active archive indexer and download client in Sonarr and Radarr. Both Bohemarr indexers explicitly select their Bohemarr download client.
- Stopped czarr and the unused legacy Media Monitor service after confirming empty czarr queues, no configured Media Monitor monitors and no active legacy work. Preserved their containers, configuration, databases and downloaded files.
- Disabled Docker restart for both retired services and placed their Compose services behind an explicit `retired` profile, excluding them from default startup. Torrent/Usenet services and their Arr configuration were left unchanged.
- Verified Bohemarr's download-client connection, Sonarr's accepted Extractors S01E01 release, and Radarr's accepted Anděl Páně (2005) releases after cutover.

### Verification and limitations

- Type checking and build passed for the archive-search changes; all 105 tests passed in Docker with the media tools available.
- Sonarr returned `Extractors S01E01 (CZ)[WEB-DL][1080p]` without rejection. A newly prefilled bilingual binding returned `The Affair S01E01 (CZ)[WEB-DL][1080p]` for the Czech programme *Aféra* through the actual Newznab service.
- Revalidated all 4,716 installed relations and checked SQLite integrity successfully.
- The account-enabled Sonarr connection test passed with five-result pages.
- This pass did **not** pair every catalogue entry. Missing or conflicting identity evidence remains unresolved rather than forced into a match.
