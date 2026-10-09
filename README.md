# Bohemarr

Bohemarr makes Czech and Slovak streaming archives available to Sonarr and Radarr. It searches enabled providers, downloads selected media, and places completed files in a shared downloads directory.

## What you need

- Docker with the Compose plugin, or Node.js 26+ for a local build.
- Sonarr and/or Radarr.
- A directory mounted into Bohemarr and the *arr applications, at the same path, for completed downloads.

## Start with Docker

```sh
git clone https://github.com/iamanro/bohemarr.git
cd bohemarr
cp .env.example .env
```

Edit `.env`, then start the service:

```sh
docker compose up -d --build
```

Every setting is in `.env`; `.env.example` documents each one. Run `docker compose up -d` again after every change. The Compose file creates a `bohemarr` Docker network and publishes the service on `PUBLISH_ADDRESS:PUBLISH_PORT`, by default `127.0.0.1:8787`.

- `PUBLIC_URL` must be the address Sonarr and Radarr use to reach Bohemarr.
- `DOWNLOADS_PATH` is the host directory for completed downloads. `DOWNLOADS_DIR` is the path of that directory inside the containers, and Sonarr and Radarr must mount it at the same path. Hardlinks also need the library on the same filesystem and in the same mount, for example the host's `/srv/data` mounted at `/data` in Sonarr and Radarr, with `DOWNLOADS_PATH=/srv/data/downloads` and `DOWNLOADS_DIR=/data/downloads`.
- Leave `API_KEY` empty to generate one and store it in the `config` volume at `/config/api-key`.
- `.env` holds provider passwords and API keys in plain text; keep it private, or read them from files (see [Secrets in files](#secrets-in-files)).

## Configure providers

`PROVIDERS` lists the enabled providers, separated by commas; every other provider is disabled. Without it, every public provider is enabled, and every account provider whose credentials are set. Provider settings are named `<PROVIDER>_<SETTING>`, for example `ONEPLAY_USERNAME` or `ONEPLAY_PROFILE_PIN`; `.env.example` lists them.

```dotenv
PROVIDERS=ceskatelevize,iprima,oneplay
IPRIMA_USERNAME=you@example.com
IPRIMA_PASSWORD=your-password
ONEPLAY_USERNAME=you@example.com
ONEPLAY_PASSWORD=your-password
CATEGORIES=tv,movies
CONCURRENCY=2
```

- `CATEGORIES` are the download-client categories Sonarr and Radarr may use.
- `CONCURRENCY` is the number of simultaneous downloads (1–32).

### Secrets in files

Values in `.env` are visible to anyone who can run `docker inspect`. Any variable can instead be read from a file: set `NAME_FILE` to its path inside the container. With Docker secrets:

```yaml
# compose.override.yaml
services:
  bohemarr:
    environment:
      ONEPLAY_PASSWORD_FILE: /run/secrets/oneplay_password
    secrets: [oneplay_password]
secrets:
  oneplay_password:
    file: ./secrets/oneplay_password
```

Setting both `NAME` and `NAME_FILE` is an error. A trailing line break in the file is ignored.

### Lists and objects

Settings that are lists or objects go in `/config/config.json`: the static catalogue (`catalog`) of a provider, such as `direct`, and the request headers (`headers`) of `html5` and `direct`. `config.example.json` shows both. The file holds nothing else; Bohemarr refuses to start when it contains another setting and names the variable to use instead. To install it:

```sh
docker compose cp config.json bohemarr:/config/config.json
docker compose exec --user root bohemarr sh -c 'chown 1000:1000 /config/config.json && chmod 600 /config/config.json'
docker compose restart bohemarr
```

## Connect Sonarr and Radarr

Put Sonarr, Radarr and Bohemarr on the same Docker network, or otherwise make `PUBLIC_URL` reachable from both applications and their URLs reachable from Bohemarr.

### Automatically

Set the URL and API key (Settings → General) of each application in `.env`:

```dotenv
SONARR_URL=http://sonarr:8989
SONARR_API_KEY=...
SONARR_ROOT_FOLDER=/data/media/tv
RADARR_URL=http://radarr:7878
RADARR_API_KEY=...
RADARR_ROOT_FOLDER=/data/media/movies
ARR_REMOVE_COMPLETED=true
```

At every start, Bohemarr creates or updates the following in each application, retrying until the application is reachable:

- a qBittorrent download client named Bohemarr, with the category `SONARR_CATEGORY` (default `tv`) or `RADARR_CATEGORY` (default `movies`);
- a Torznab indexer named Bohemarr with RSS, Automatic Search and Interactive Search enabled, which sends its grabs to that client;
- a tag `bohemarr` with a Delay Profile without torrent delay;
- the root folder, when `SONARR_ROOT_FOLDER` or `RADARR_ROOT_FOLDER` is set.

These settings are reapplied at every start, so change them in `.env`, not in Sonarr or Radarr. `docker compose logs bohemarr` shows whether each application was configured. Then add the `bohemarr` tag to every series and movie you download from Bohemarr, unless your default Delay Profile already has no torrent delay.

`ARR_REMOVE_COMPLETED` decides what happens to a completed download. Bohemarr seeds nothing, so its seeding goal counts as reached on completion:

- `true`: Sonarr and Radarr move the file into the library and remove the download from Bohemarr.
- `false`: they copy the file, or hardlink it when **Use Hardlinks instead of Copy** is on, and the download stays until you remove it.

### By hand

Leave `SONARR_URL` and `RADARR_URL` empty. Read the API key with `docker compose exec bohemarr cat /config/api-key`, then add Bohemarr to each application twice, both pointing at the host and port of `PUBLIC_URL`:

- **Indexer: Torznab.** URL `PUBLIC_URL`, API Path `/api`, API Key the generated key. Use category 5000 (TV) in Sonarr and 2000 (Movies) in Radarr. Enable RSS and Automatic Search.
- **Download client: qBittorrent.** Any username, the API key as password. Category `tv` in Sonarr and `movies` in Radarr. Bohemarr does not create categories; they must be listed in `CATEGORIES`. **Remove Completed** has the effect described for `ARR_REMOVE_COMPLETED`.
- **Delay Profile:** Sonarr treats Bohemarr releases as torrents, and a Delay Profile's Torrent delay holds every RSS grab for that long. Give a tag such as `bohemarr` a Delay Profile with a Torrent delay of `0`, and add the tag to every series you download from Bohemarr.

### Automatic downloads

Interactive Search alone is manual. Sonarr grabs an episode published after it aired only through RSS sync, which the indexer settings above enable. Search each existing series once by running an interactive search for any one episode. Series you add later are searched automatically when you add them. Run one interactive search first and confirm that the releases and the downloaded file import correctly.

How the RSS feed works:

- It lists the five newest episodes of every series Sonarr has searched by TVDB ID. A series stays in the feed after that, including between seasons.
- Oneplay and Prima+ series appear once their program is bound. The first TVDB search binds it.
- Each item is dated when the feed first lists it. The feed refreshes at most every ten minutes.
- Until Sonarr has searched any series, the feed shows the catalogue browse page instead. Otherwise Sonarr could not save the indexer.

Radarr movie searches can include a TMDB ID. Bohemarr uses a verified local provider binding for that ID when one exists; otherwise it searches enabled providers by the title and year Radarr supplies. Matching results retain the TMDB ID.

If Prowlarr manages the indexer with Full Sync, configure those options in its sync profile or use Add/Remove Only. Full Sync otherwise overwrites local Sonarr/Radarr settings. Do not let Prowlarr manage the indexer when Bohemarr configures Sonarr and Radarr itself.

## Publish to Vltava

Bohemarr can upload what Sonarr and Radarr import to the Vltava tracker and seed it. For every imported file that Bohemarr downloaded from a provider in `VLTAVA_PROVIDERS`:

1. Sonarr or Radarr reports the import to Bohemarr through a Webhook connection named Bohemarr. Bohemarr creates it when it configures them automatically. When you connect them [by hand](#by-hand), add one yourself: **Settings → Connect → Webhook**, URL `PUBLIC_URL/hooks/arr?apikey=<API key>`, method POST, **On Import** and **On Upgrade**.
2. Bohemarr runs Vltava's own `vltava upload` CLI. Vltava plans the canonical name, the CLI hardlinks the file into that tree under `VLTAVA_OUT_DIR/<id>/`, builds the `.torrent` and uploads it with the TMDB ID from Sonarr or Radarr, the episode, the resolution, type WEB-DL and a Markdown description. The upload waits in Vltava's moderation queue unless the account may upload without moderation.
3. Bohemarr adds the personal `.torrent` to a dedicated [rqbit](https://github.com/ikatson/rqbit) server, which verifies the files in that tree and seeds them. A publication counts as seeding once every piece is verified; a tree whose files do not match the torrent fails, and rqbit lets go of it so it never downloads.

Only single-episode files and titles with a TMDB ID are published. Each import is published once; a failed step is retried after 5 minutes, doubling up to 6 hours, and gives up after 8 attempts. A torrent Vltava already has, or a failed upload that left no `.torrent`, is not retried. `docker compose logs bohemarr` shows each step (`Vltava: uploaded …`, `Vltava: seeding …`).

To enable it, in `.env`:

```dotenv
COMPOSE_FILE=compose.yaml:compose.vltava.yaml
VLTAVA_SOURCE=/path/to/vltava          # the image builds the vltava CLI from it
MEDIA_PATH=/srv/storage/media          # host library
MEDIA_DIR=/data                        # the same library inside Sonarr and Radarr
VLTAVA_URL=https://vltava.example.org
VLTAVA_TOKEN=...                       # API token with the upload scope
VLTAVA_PROVIDERS=ceskatelevize,stvr
VLTAVA_OUT_DIR=/data/vltava
VLTAVA_GROUP=BOHEMARR
VLTAVA_SEEDER_USERPASS=bohemarr:...   # rqbit's HTTP API login
```

- **Seeder.** Point `VLTAVA_SEEDER_URL` at the rqbit Vltava runs for its community seedbox, so one rqbit behind the seedbox's VPN seeds both. Vltava's staff page `/seedbox` then lists the publications as foreign torrents and can pause, remove or delete them. Deleting there removes the publication's tree, not the library file, and Bohemarr does not add it again. Keep `VLTAVA_OUT_DIR` outside Vltava's `SEEDBOX_SAVE_PATH`, because Vltava removes unknown torrents inside it. That rqbit must see the library at the same `MEDIA_DIR` path.
- `compose.vltava.yaml` builds the CLI into the image and mounts the library into Bohemarr at `MEDIA_DIR`. With `COMPOSE_PROFILES=seeder` it also runs its own rqbit as `vltava-seeder`, with its Web UI at `/web/` on `VLTAVA_SEEDER_PUBLISH_PORT` and peers on `VLTAVA_TORRENTING_PORT`. That port must be reachable from the internet, or the torrents are not seeded. rqbit keeps its torrents in the `vltava-seeder` volume and resumes after a restart without hashing the files again; DHT, LSD and UPnP are off.
- The paths Sonarr and Radarr report must exist at the same path in Bohemarr and in `vltava-seeder`, so mount the library at the same `MEDIA_DIR` everywhere. rqbit opens files read/write even to seed, so its mount cannot be read-only.
- Hardlinks need `VLTAVA_OUT_DIR` on the library's filesystem and in the same mount. On a mergerfs pool, a hardlink can still fail when the file and the tree land on different branches. In that case set `VLTAVA_LINK=copy`, which uses space for a second copy.
- List only providers whose content you may redistribute. Publishing shares the files publicly through the tracker; for providers with DRM, Bohemarr removed that protection to download them.

## Build from source

```sh
npm ci
npm run check
npm test
npm run build
npm start
```

Build the production image with:

```sh
docker build -t bohemarr:local .
```

## Operate

```sh
# Service state and recent logs
docker compose ps
docker compose logs -f bohemarr

# Apply a changed .env
docker compose up -d
```

Persistent state is in the `config` volume at `/config`; completed downloads are in `DOWNLOADS_DIR/<category>/`. Back up `/config` before upgrades if you need to keep the configuration, generated key, queue, and provider bindings.

## Troubleshooting

- **Interactive search works but nothing grabs automatically:** follow [Automatic downloads](#automatic-downloads). A series enters the RSS feed only after its first TVDB search.
- **A download stays queued with "max. počet současných sledování":** another device is using every concurrent stream of the account (Oneplay). Bohemarr retries every five minutes and reports a failure only after twelve hours.
- **An RSS release stays in the Sonarr queue as `delay`:** the series lacks the tag whose Delay Profile sets the Torrent delay to `0`.
- **A failed download stays in the queue with "qBittorrent is reporting an error":** Sonarr and Radarr never run failed-download handling for qBittorrent, so they do not blocklist the release or search for another. Check `docker compose logs bohemarr`, then remove the item from the queue, with blocklisting if the release cannot be downloaded.
- **A provider returns no results:** verify that it is enabled and that account credentials, when required, are valid. Check `docker compose logs bohemarr`.
- **Sonarr or Radarr cannot import a completed file:** mount the host's `DOWNLOADS_PATH` into both applications at `DOWNLOADS_DIR`, or configure a Remote Path Mapping.
- **An import is not published to Vltava:** the log names the reason it was skipped (provider not in `VLTAVA_PROVIDERS`, no TMDB ID, more than one episode in the file) or the step that failed. An `rqbit … HTTP 401` means `VLTAVA_SEEDER_USERPASS` differs from what `vltava-seeder` was started with.
- **Indexer or download-client test fails:** verify `PUBLIC_URL`, the API key, and Docker network connectivity.
- **The log shows "Sonarr setup failed" or "Radarr setup failed":** the message names the request Sonarr or Radarr rejected. Check `SONARR_URL`/`RADARR_URL`, their API keys and `PUBLIC_URL`; Bohemarr keeps retrying.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
