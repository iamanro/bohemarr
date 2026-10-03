# Changelog

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
