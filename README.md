# Bohemarr

Bohemarr makes Czech and Slovak streaming archives available to Sonarr and Radarr. It searches enabled providers, downloads selected media, and places completed files in a shared downloads directory.

## What you need

- Docker with the Compose plugin, or Node.js 26+ for a local build.
- Sonarr and/or Radarr.
- A directory mounted into Bohemarr and the *arr applications for completed downloads.

## Start with Docker

```sh
git clone https://github.com/iamanro/bohemarr.git
cd bohemarr
cp config.example.json config.json
```

Edit `config.json`, then start the service:

```sh
docker compose up -d --build
docker compose cp config.json bohemarr:/data/config.json
docker compose exec --user root bohemarr sh -c 'chown 1000:1000 /data/config.json && chmod 600 /data/config.json'
docker compose restart bohemarr
```

The Compose file creates a `bohemarr` Docker network and publishes the service only on `127.0.0.1:8787`. Set these optional values in `.env` before starting:

```dotenv
PUBLIC_URL=http://bohemarr:8787
DOWNLOADS_PATH=/absolute/path/to/downloads
API_KEY=
TZ=Europe/Prague
```

`PUBLIC_URL` must be the address Sonarr and Radarr use to reach Bohemarr. Leave `API_KEY` empty to generate and store one in the data volume.

## Configure providers

`config.example.json` lists every available provider. Start with only the sources you need. Public providers need no account; account providers need their login details.

```json
{
  "categories": ["tv", "movies"],
  "concurrency": 2,
  "providers": {
    "ceskatelevize": { "enabled": true },
    "streamcz": { "enabled": false },
    "iprima": {
      "enabled": true,
      "username": "you@example.com",
      "password": "your-password"
    },
    "oneplay": {
      "enabled": true,
      "username": "you@example.com",
      "password": "your-password"
    }
  }
}
```

- Set `enabled` to `false` to remove a provider from new searches and grabs.
- `categories` must match the categories used by the Sonarr and Radarr download-client configuration.
- `concurrency` is the number of simultaneous downloads (1–32).
- Provider passwords are stored in plain text in `config.json`; keep the file and `/data` private.
- Restart Bohemarr after every configuration change.

## Connect Sonarr and Radarr

1. Put Sonarr, Radarr, and Bohemarr on the same Docker network, or otherwise make `PUBLIC_URL` reachable from both applications.
2. Read the generated key:

   ```sh
   docker compose exec bohemarr cat /data/api-key
   ```

3. Add Bohemarr as the indexer and download client in each application. Use the TV category for Sonarr and the movie category for Radarr.
4. Run one interactive search first. Confirm that the releases and downloaded file import correctly.
5. To grab monitored media automatically, follow [Automatic downloads](#automatic-downloads).

### Automatic downloads

Interactive Search alone is manual. Sonarr grabs an episode published after it aired only through RSS sync. To set this up:

1. Enable **RSS** and **Automatic Search** for the Bohemarr indexer in Sonarr.
2. Sonarr treats Bohemarr releases as Usenet, and a Delay Profile's Usenet delay holds every RSS grab for that long. Create a tag such as `bohemarr`. Give it a Delay Profile with a Usenet delay of `0`, then add the tag to every series you download from Bohemarr.
3. Search each existing series once by running an interactive search for any one episode. Series you add later are searched automatically when you add them.

How the RSS feed works:

- It lists the five newest episodes of every series Sonarr has searched by TVDB ID. A series stays in the feed after that, including between seasons.
- Oneplay and Prima+ series appear once their program is bound. The first TVDB search binds it.
- Each item is dated when the feed first lists it. The feed refreshes at most every ten minutes.
- Until Sonarr has searched any series, the feed shows the catalogue browse page instead. Otherwise Sonarr could not save the indexer.

Radarr movie searches can include a TMDB ID. Bohemarr uses a verified local provider binding for that ID when one exists; otherwise it searches enabled providers by the title and year Radarr supplies. Matching results retain the TMDB ID.

If Prowlarr manages the indexer with Full Sync, configure those options in its sync profile or use Add/Remove Only. Full Sync otherwise overwrites local Sonarr/Radarr settings.

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

# Restart after changing config
docker compose restart bohemarr
```

Persistent state is in `/data`; completed downloads are in `/downloads/<category>/`. Back up `/data` before upgrades if you need to keep the configuration, generated key, queue, and provider bindings.

## Troubleshooting

- **Interactive search works but nothing grabs automatically:** follow [Automatic downloads](#automatic-downloads). A series enters the RSS feed only after its first TVDB search.
- **A download stays queued with "max. počet současných sledování":** another device is using every concurrent stream of the account (Oneplay). Bohemarr retries every five minutes and reports a failure only after twelve hours, so Sonarr does not blocklist the episode in the meantime.
- **An RSS release stays in the Sonarr queue as `delay`:** the series lacks the tag whose Delay Profile sets the Usenet delay to `0`.
- **A provider returns no results:** verify that it is enabled and that account credentials, when required, are valid. Check `docker compose logs bohemarr`.
- **Sonarr or Radarr cannot import a completed file:** mount the same host downloads directory into both applications, or configure a Remote Path Mapping.
- **Indexer or download-client test fails:** verify `PUBLIC_URL`, the API key, and Docker network connectivity.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
