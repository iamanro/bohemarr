# Bohemarr

Headless service that presents Czech and Slovak streaming sources to Sonarr/Radarr as a Newznab indexer and a SABnzbd-compatible download client, then downloads the original media.

## Language

### Sources

**Provider**:
A streaming source the service can search and download from, identified by a provider ID such as `iprima` or `oneplay`.
_Avoid_: plugin, engine, site

**Catalogue**:
A provider's ordered listing of Programs, including any static catalogue entries configured for that provider.
_Avoid_: index, library, browse list

**Program**:
A provider's own catalogue entry that holds episodes or is itself a movie.
_Avoid_: programme, show, source series, title

**Release**:
One downloadable episode or movie offered by a provider, identified durably rather than by a short-lived playback URL.
_Avoid_: item, result, stream

**Account session**:
A provider's authenticated state, obtained from the user's account credentials or from a session configured for that provider.
_Avoid_: auth, login, token

**Rejected session**:
An Account session the provider's upstream refuses; it is discarded and replaced by one new login.
_Avoid_: expired session, invalid token

### Series identity

**Series identity**:
The canonical TVDB record of a series: title, aliases, first-aired year and origin country.
_Avoid_: TVDB show, series metadata

**Series binding**:
The stored pairing of one Series identity with one Program of one provider; once stored it is never reassigned.
_Avoid_: mapping, pairing, match

**Watched series**:
A Series identity Sonarr has searched by TVDB ID; the RSS feed lists its newest Releases from then on.
_Avoid_: followed, subscribed, monitored (Sonarr's own term)

**Unbound**:
The state of a Series identity for which no Program of a given provider qualifies; that provider returns no Releases for it.
_Avoid_: unmatched, not found

### Downloads

**Job**:
One download of a Release into a category, with a status of queued, downloading, paused, completed or failed.
_Avoid_: task, download (as a noun)

**Task descriptor**:
The signed NZB envelope naming a Release, which only this service instance can execute.
_Avoid_: NZB, ticket
