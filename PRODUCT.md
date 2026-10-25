# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Self-hosters in the open-source community who already run Sonarr and/or Radarr, usually in Docker on a home server, and want Czech and Slovak streaming archives in that library. They set Bohemarr up once from the README and `.env`, then open the web UI occasionally: to enter provider accounts, check or manage downloads, search and download something by hand, or change connections and settings. The UI must let them get through first-time setup without reading code.

## Product Purpose

Bohemarr is a headless service with no library of its own. It presents Czech and Slovak streaming sources (Česká televize, Prima, Oneplay, Nova/Markíza/Voyo, JOJ, Webshare, Přehraj.to and others) to Sonarr and Radarr as a Torznab indexer and a qBittorrent-compatible download client, then downloads the original media into a shared downloads directory for the *arr applications to import. Success: Sonarr and Radarr find and import Czech/Slovak releases as if they came from any other indexer, with no manual steps.

The web UI (`/ui/`) is a supporting management tool (Operate), not the main product.

## Positioning

It speaks the protocols Sonarr and Radarr already understand (Torznab, qBittorrent API) instead of asking users to adopt a new library app, and it downloads from the broadcasters' own archives rather than from torrents.

## Operating Context

- Deployed with Docker Compose; configured through `.env` (documented in `.env.example`), optional `/config/config.json` for lists and objects, and settings saved from the UI to `/config/settings.json`.
- A variable set in `.env` always wins and shows read-only in the UI; UI changes apply after **Restart to apply**.
- Sign-in to the UI is the service's API key.
- Users live alongside the Sonarr/Radarr UIs and their conventions.

## Capabilities and Constraints

- UI sections: Downloads (pause, resume, remove Jobs), Search (search enabled providers, download a result into a category), Providers, Accounts, Sonarr & Radarr connections, General download settings.
- UI language is English, like the *arr ecosystem; only program titles are Czech/Slovak.
- Domain vocabulary (Provider, Program, Release, Job, Series binding…) is defined in `CONTEXT.md` and is binding for UI copy.
- Web UI stack: React + Vite, shadcn/ui components in `web/src/components/ui/`, its own `bun.lock`.
- Some providers require paid accounts; credentials are sensitive.

## Evidence on Hand

- `README.md`, `CONTEXT.md`, `docs/adr/`.
- No user counts, testimonials, screenshots or press; do not fabricate them.

## Product Principles

1. Fit the *arr ecosystem: behave and read like a native neighbour of Sonarr and Radarr.
2. Setup without code: every setting a self-hoster needs is reachable and explained in the UI or `.env.example`.
3. Secrets stay secret: credentials and API keys are never exposed beyond what the task needs.
4. The service does the work; the UI exists for setup, oversight and the occasional manual action.
