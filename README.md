# Music

A custom, mobile-first web client for [Navidrome](https://www.navidrome.org/), plus a tiny API for the two things
the OpenSubsonic API cannot do: **delete a song file** and **add songs** (downloaded with `yt-dlp`).
Installable as a PWA (iPhone/Android home screen).

| Service | Image | Role |
|---|---|---|
| `music-web` | `nginx-unprivileged` (pinned digest) | Serves the static SPA in `web/` and reverse-proxies, same origin, `/rest/*` to Navidrome and `/api/*` to `music-api` |
| `music-api` | build `api/` (Node + bash + ffmpeg + yt-dlp) | Delete / add songs, library disk usage; live output of `add_musics.sh` over Server-Sent Events |

Both containers are read-only, drop all capabilities and run with `no-new-privileges`.

## How auth works

There is no separate login: the UI signs in to Navidrome with the Subsonic token scheme (`u`, `t`, `s`; the
password never leaves the browser). `music-api` receives the same `u/t/s` and replays them to Navidrome
(`getUser`) to check that they are valid **and belong to an admin** before touching any file.

The Subsonic API only exposes a virtual `Artist/Album/Title` path, so the real file path is read by song id from
Navidrome's own SQLite database, mounted read-only.

## Requirements

- A running Navidrome stack whose compose network is `navidrome_default` and whose data folder is
  `../navidrome/data` (next to this folder). Adjust `docker-compose.yml` if yours differ.
- The music library at `/mnt/storage/music`, owned by uid/gid `1000` (the `user:` of `music-api`).
- The stack is **pool-gated**: every bind mount uses `create_host_path: false` and `music-api` mounts the marker
  `/run/storage-pool-ready`, touched by a host script (`AUX/scripts/startup/wait-for-pool.sh`) once the storage
  pool is fully mounted. On a single-disk host, create the marker at boot (e.g. a `tmpfiles.d` entry) or drop that mount.

## Deploy

    sudo bash ./deploy.sh

It builds and starts the stack, installs `music-compose.service` (paths filled in from where the repo lives; `AUX`
defaults to `../aux`) so the stack starts at boot only after the pool is ready, and, if present, runs
`AUX/scripts/setup/restrict-to-proxy.sh` to firewall port 4041 to the reverse proxy.

The UI listens on host port `4041` (`WEB_PORT`). Point a reverse proxy vhost at it; nothing else needs routing,
since `music-web` already proxies `/rest` and `/api`.

## Adding songs from the shell

    DEST_DIR=/path/to/library ./add_musics.sh "Artist - Song" "https://youtube.com/watch?v=..."

Each entry is searched on YouTube (or used as a link), converted to MP3 in a temp folder, and only moved into the
library if a file with the same name is not already there. The API triggers a Navidrome rescan when it adds songs.

## PWA notes

- `web/sw.js` caches only the app shell, network first; `/rest` and `/api` always go to the network.
- Service workers need a secure origin. On plain HTTP, Chrome for Android only installs the app with the flag
  `unsafely-treat-insecure-origin-as-secure` set for the site.

## Files

`docker-compose.yml` · `nginx.conf` · `api/` (server + Dockerfile) · `web/` (static SPA) · `add_musics.sh` ·
`deploy.sh` · `music-compose.service` (systemd template)
