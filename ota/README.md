# Over-the-air updates for the TV app

The packaged widget updates itself from this repository's Cloudflare Worker, so a fix reaches installed TVs without reinstalling the widget with `sdb`/`tizen install`.

## How it works

- **The widget** (`writeWidget` in `build.mjs`): `index.html` is a small loader (`ota.js` plus a generated `ota-config.js`), and the app build sits under `app/`.
- **The Worker** (`writeUpdate`): the Worker build copies the same app build to `/tv-app/v/<build id>/` and writes `/tv-app/manifest.json`. Workers Builds deploys it on every push to `main`. A build's id is a hash of its files and page markup, so the widget and the Worker agree when they hold the same build.
- **On the TV** (`ota.js`):
  1. The app starts at once from the newest build already on the TV: either `app/` or a build downloaded earlier. The loader writes that build's page in place with a `<base>` pointing at it. Nothing waits on the network.
  2. Ten seconds after the page has loaded, and again when the app returns to the foreground after 3 hours or more, the loader fetches the manifest. It never does this while a video is playing.
  3. If the manifest names a different build, the loader downloads every file, checks the sizes, and records the build in `localStorage`. The files land in the HTTP cache (`immutable`, one year). A notice (15 seconds) says the update applies at the next launch.
  4. The next launch runs the new build from the cache and says once that the app was updated.

## Safety

- **Offline or cache evicted:** if a file of the downloaded build fails to load, the loader drops that build and restarts with the bundled one.
- **Repeated failed launches:** if a downloaded build fails three launches in a row (the page never finishes loading, or the app closes within 5 seconds of loading), the loader marks it bad and runs the bundled build. A bad build is tried again after a day, or when the next push publishes a different build.
- **Rollback:** roll back the Worker deployment in Cloudflare, or revert the commit. TVs follow whatever the manifest names, including the bundled build.
- **A broken build can still be replaced:** the update check runs in the loader, not in the app, so the next push reaches TVs even when the current build's app code is broken.

## When a reinstall is still needed

Only for changes outside the app build: `tizen/config.xml` (privileges, CSP, version, app id), the icon, or this loader. The release workflow (`.github/workflows/release.yml`) publishes a widget for every push to `main` for that purpose.

The release widget is signed when the repository has these secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|-|-|
| `TIZEN_AUTHOR_P12` | `base64 -i ~/SamsungCertificate/<profile>/author.p12` |
| `TIZEN_AUTHOR_PASSWORD` | the author certificate password |
| `TIZEN_DISTRIBUTOR_P12` | `base64 -i ~/SamsungCertificate/<profile>/distributor.p12` |
| `TIZEN_DISTRIBUTOR_PASSWORD` | the distributor certificate password |

Without them the release carries an unsigned widget, which a TV will not install.
