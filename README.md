# PuffcoBLE Controller
Web app and command-line controller for a Puffco device. The app
can talk to the device directly from the browser with Web Bluetooth on HTTPS,
localhost, or 127.0.0.1. The Windows Python bridge remains available as a
fallback and for CLI/dev workflows.

The launcher opens `http://localhost:8420` and runs the stdlib HTTP server plus
a local WebSocket control channel. Keep the terminal open while using the app.

Or run the server directly with an installed Windows Python:

```powershell
C:\Python314\python.exe .\server.py --open
```

Open `http://localhost:8420`. In Chrome or Edge the default transport is
Browser Bluetooth, which opens the browser device chooser and talks to the
Puffco without the WebSocket bridge. The web app includes connection
management, live status, heat/boost/stop, profile selection and editing, hex
color changes, 1-100% LED brightness, lantern and stealth toggles,
battery/version LED display, sleep, power off, and guarded factory reset.

## GitHub Pages Deployment

This project can publish the static UI with GitHub Pages. Chrome and Edge allow
Web Bluetooth from secure HTTPS pages, so the public Pages site can connect to
the Puffco directly through the browser Bluetooth chooser, like `puffco.app`.
The local Windows bridge is only a fallback for browsers/environments that block
Web Bluetooth.

Deployment layout:

- `web/` is the static public site.
- `.github/workflows/pages.yml` publishes `web/` whenever `main` is pushed.
- `web/ble-client.js` is the browser-native Lorax/Web Bluetooth transport.
- `server.py` remains the optional local Windows bridge and exposes
  `ws://127.0.0.1:8421/ws` when you need it.
```text
ws://127.0.0.1:8421/ws
```

## Setup

The runtime is intentionally Windows-local and minimal. Required at run time:

- Windows 10/11 with Bluetooth LE enabled
- Python 3.11+ for Windows
- The `.venv-puffco\Lib\site-packages` package folder beside `start.bat`
- A Chromium-family browser, Edge, Chrome, or similar

No Node.js is required to run the app. The `browser_*.js` files are only local
test harnesses.

Use the same Python for CLI commands:

```powershell
C:\Python314\python.exe .\puffcussy.py --help
```

For faster repeated use, set your device address once:

```powershell
$env:PUFFCO_MAC="F0:AD:4E:4B:75:1B"
```

Add `--quick` to one-shot commands when you want one fast connection attempt instead of retries.

## Common Commands

```powershell
C:\Python314\python.exe .\puffcussy.py find
C:\Python314\python.exe .\puffcussy.py doctor
C:\Python314\python.exe .\puffcussy.py info --quick
C:\Python314\python.exe .\puffcussy.py info --full --json --quick
C:\Python314\python.exe .\puffcussy.py about --json --quick
```

For repeated actions without reconnecting every time:

```powershell
C:\Python314\python.exe .\puffcussy.py session
```

Inside `session`, use commands like `info`, `heat`, `stop`, `boost`, `profiles`,
`profile 1`, `lantern on`, `stealth off`, `brightness 128 128 128 128`,
`color "#00aaff"`, `battery`, `state`, and `quit`.

## Heat Control

```powershell
C:\Python314\python.exe .\puffcussy.py heat --yes --fast --quick
C:\Python314\python.exe .\puffcussy.py boost --quick
C:\Python314\python.exe .\puffcussy.py stop --quick
C:\Python314\python.exe .\puffcussy.py monitor --seconds 120
```

## Live Chamber Temperature Mapping

Live temperature is never fabricated. Until a firmware path is proven, the UI
shows `Current --`. During a real heat cycle the server automatically samples
read-only heater candidates and promotes a path only when repeated samples look
like a plausible chamber temperature and change over time.

Once promoted, the mapping is saved in `lorax_mappings.json` and reused on the
next app launch. Delete that file, or send the `temperature_source` command with
`{"clear": true}`, to force rediscovery.

## Profiles

```powershell
C:\Python314\python.exe .\puffcussy.py profile list --quick
C:\Python314\python.exe .\puffcussy.py profile list --json --quick
C:\Python314\python.exe .\puffcussy.py profile select 1 --quick
C:\Python314\python.exe .\puffcussy.py profile set 1 --name Evening --temp 520 --time 45 --color "#00aaff" --select
```

Back up profiles before experimenting:

```powershell
C:\Python314\python.exe .\puffcussy.py profile export --output profiles.json
C:\Python314\python.exe .\puffcussy.py profile restore profiles.json
C:\Python314\python.exe .\puffcussy.py profile restore profiles.json --select-active --yes
```

`profile restore` is a dry run until `--yes` is passed.

## Lights And Power

```powershell
C:\Python314\python.exe .\puffcussy.py light lantern on --quick
C:\Python314\python.exe .\puffcussy.py light stealth on --quick
C:\Python314\python.exe .\puffcussy.py light brightness --base 128 --mid 128 --glass 128 --logo 128
C:\Python314\python.exe .\puffcussy.py light show-battery --quick
C:\Python314\python.exe .\puffcussy.py power sleep --quick
C:\Python314\python.exe .\puffcussy.py power off --quick
```

## Advanced Reads And Writes

```powershell
C:\Python314\python.exe .\puffcussy.py read /p/app/stat/id --size 1 --type uint8
C:\Python314\python.exe .\puffcussy.py write /u/app/ui/stlm 1 --type uint8
C:\Python314\python.exe .\puffcussy.py write /u/app/ui/stlm 1 --type uint8 --yes
```

`write` is also a dry run until `--yes` is passed.
