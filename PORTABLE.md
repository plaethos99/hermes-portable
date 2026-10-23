# Hermes Desktop portable build

This file records the work done to make Hermes Desktop run from one folder, with no install step and no files written to the Windows temp directory on `C:`.

The folder you copy to another computer is:

`C:\Users\Admin\Downloads\hermes-desktop\dist\HermesPortable`

Start it by double-clicking:

`C:\Users\Admin\Downloads\hermes-desktop\dist\HermesPortable\Hermes.exe`

On 2026-10-23 the checkout moved from `D:\hermes-desktop` to `C:\Users\Admin\Downloads\hermes-desktop`. Its old build output and caches on `D:` were deleted, and the portable folder was rebuilt in the new location. The `D:` paths below record where the earlier work happened.

## What you asked for

- Remove every Hermes install and data store from the `C:` drive.
- Run the app only from `D:\hermes-desktop`.
- Do not allocate space in `C:\Users\...\AppData` or in the Windows temp folder.
- Do not ask to install a separate Hermes agent. The agent, Python, and the desktop app must already be inside the folder.
- Click one `.exe` and have it start. Nothing should download at launch.
- Do not use a self-extracting exe. Those unpack into the Windows temp folder.
- The shipped folder must behave like a new install. It must not reuse existing profiles, keys, or other Hermes or ERP agents already on this computer.
- Chat must actually return a reply.

## Where the app lives

| Piece | Path |
| --- | --- |
| Click target | `dist\HermesPortable\Hermes.exe` |
| Electron app | `dist\HermesPortable\app\hermes-agent.exe` |
| Agent source and virtual environment | `dist\HermesPortable\runtime\hermes\hermes-agent` |
| Python 3.14.0rc2 | `dist\HermesPortable\runtime\python` |
| Hermes home (config, sessions, logs) | `dist\HermesPortable\runtime\hermes` |
| Electron profile | `dist\HermesPortable\runtime\electron` |
| Scratch files | `dist\HermesPortable\runtime\scratch` |
| Bundled tools (cua-driver, agent-browser, Chromium, ffmpeg, node, ripgrep) | `dist\HermesPortable\runtime\hermes\tools` |

`Hermes.exe` is a small launcher. It is not a self-extracting archive. The rest of `HermesPortable` has to travel with it. Copy the whole folder, then click `Hermes.exe` on the other computer.

A checked launch used `--user-data-dir=D:\hermes-desktop\dist\HermesPortable\runtime\electron` and created no new directory in `C:\Users\Admin\AppData\Local\Temp`.

## What was removed from `C:`

These were Hermes leftovers. User data that mattered was moved into `D:\hermes-desktop\runtime\hermes` before the `C:` copies were deleted. The later portable rebuild did **not** copy those profiles into `dist\HermesPortable`.

- `%LOCALAPPDATA%\hermes` (profiles, sessions, skills, memories)
- The `uv` tool install of `hermes-agent`, including the `hermes`, `hermes-agent`, and `hermes-acp` commands in `%USERPROFILE%\.local\bin`
- `uv` caches that contained only the Hermes package
- The `hermes://` protocol key under `HKCU\Software\Classes\hermes`
- Start-menu tile entries and a recent shortcut
- The user `PATH` entry `C:\Users\Admin\AppData\Local\hermes\bin`
- Claude’s sandboxed copy at `Packages\Claude_...\LocalCache\Local\hermes`
- Hermes temp files and Intel shader caches named `Hermes_0`, `Hermes_1`, and `Hermes_2`

Left in place on purpose:

- `D:\erp-agent\.tools\hermes-agent` (not on `C:`)
- Generic Electron caches from 2025 at `%LOCALAPPDATA%\electron` and `%APPDATA%\Electron` (not Hermes data)

## How the launcher stays inside the folder

`scripts\portable-launcher\main.go` is compiled to `Hermes.exe`. On startup it:

1. Uses its own directory as the portable root.
2. Sets `HERMES_HOME`, `HERMES_DESKTOP_USER_DATA_DIR`, `TEMP`, `TMP`, and `TMPDIR` under `runtime\`.
3. Sets `PYTHONNOUSERSITE=1` so Python does not read or write `%APPDATA%\Python`.
4. Rewrites `runtime\hermes\hermes-agent\venv\pyvenv.cfg` so the virtual environment points at `runtime\python` inside this folder. Windows does not accept a relative `home` in that file, so the launcher writes the absolute path on every start. After the folder is copied, the next click updates the path.
5. Drops inherited `HERMES_*`, `ERP_*`, `API_SERVER_KEY`, `*_API_KEY`, and `*_TOKEN` values, plus `PYTHONPATH` and `VIRTUAL_ENV`. `PATH` entries that contain `hermes` or `erp-agent` are removed. This is what keeps the exe from attaching to another agent already installed on the machine.
6. Puts the bundled tool folders listed in `runtime\hermes\tools\facts.json` (ffmpeg, node, ripgrep, cua-driver, agent-browser) at the front of `PATH`. This runs after step 5, which would otherwise remove them because their path contains `hermes`.
7. Starts `app\hermes-agent.exe`. It does not start `electron-vite`, and the other computer does not need Node.js.

`HERMES_PORTABLE=1` also turns off the desktop auto-updater, so launch does not download an update.

The same path rules exist in `src\main\portable-layout.ts` and `src\main\portable-paths.ts` for a dev launch. `Run-Portable.cmd` is an older launcher. Use `Hermes.exe`.

## What is bundled

The agent checkout that was cloned into the repo was placed at `runtime\hermes\hermes-agent` and installed into a virtual environment with the Python that ships in `runtime\python`.

Python is CPython 3.14.0rc2 because this agent’s dependency pins install only on Python 3.14. That release candidate’s `typing._eval_type` no longer accepts `prefer_fwd_module`, but Pydantic 2.13.4 still passes it. Importing the OpenAI client then crashed with:

`Failed to initialize OpenAI client: _eval_type() got an unexpected keyword argument 'prefer_fwd_module'`

`venv\Lib\site-packages\sitecustomize.py` drops that argument when this interpreter does not support it. After that change, `import openai` succeeds in the portable virtual environment.

`aiohttp==3.14.3` is installed in the same virtual environment. The desktop chat window talks to a local API server (`http://127.0.0.1:8642`). Without `aiohttp` the gateway logged `API Server: aiohttp not installed` and never opened that port, so the window stayed empty even when the model had already answered.

All provider and search API SDKs are pre-installed into the bundled venv so no network downloads are ever needed:
- `openai`: OpenAI, OpenRouter, Groq, DeepSeek, Together, Fireworks, Cerebras, Mistral, Perplexity, Moonshot/Kimi, DashScope/Qwen, MiniMax, GLM, etc.
- `anthropic`: Anthropic Claude native API
- `agent.gemini_native_adapter` & `google-auth`: Google Gemini & Vertex AI
- `boto3`: AWS Bedrock
- `duckduckgo_search`, `ddgs`, `tavily-python`, `exa_py`, `firecrawl-py`: Web Search and Extraction tools

The agent's package manager store (`runtime\hermes\tools`) is bundled too, so these tools work without a download:

- `cua-driver`: the `computer_use` tool (screenshots, clicks, and typing in any desktop app)
- `agent-browser` and Chromium: the `browser_*` tools
- `ffmpeg`: audio and video conversion and editing
- `node`, `npm`, `ripgrep`: required by the store check, and used for code search and JavaScript tooling
- PM's own `python` and `uv` entries, which `hermes pm` creates the first time it runs

## Fresh install, not your old profiles

The first portable folder had been filled with data moved from `C:`, including the `erp-info`, `erp-operator`, and `mine` profiles. That was removed.

`dist\HermesPortable` is built clean with:

- a new unpacked Electron app in `app\`
- Python and the agent runtime with all API SDKs pre-installed
- an empty Hermes home with no stale databases, caches, or logs
- automatic generation of `API_SERVER_KEY` on first start so chat authentication works immediately without error banners

It does not contain old profiles, personal keys, or `models.json` from any previous copy. The first time you click `Hermes.exe` on another machine, it initializes inside the folder. You set your model provider and API key in the UI. Everything is stored strictly inside `dist\HermesPortable\runtime\hermes\.env`.

## How the portable folder is produced

Run the automated build script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1
```

This script:
1. Verifies all 13 API SDKs in the embedded Python virtual environment.
2. Installs `cua-driver`, `agent-browser` (with Chromium), `ffmpeg`, `node`, `npm`, and `ripgrep` into `runtime\hermes\tools` with `hermes pm install`, then checks the store. The first build downloads about 1 GB; later builds only re-verify.
3. Compiles `Hermes.exe` from `scripts\portable-launcher\main.go` with `-H windowsgui` and sandboxing flags. The Go build cache stays in `runtime\cache\go`.
4. Builds the production UI via `electron-vite build` with caches redirected to `runtime\`.
5. Builds the unpacked Electron app via `electron-builder --dir --config.directories.output=dist/builder`.
6. Mirrors the clean Python runtime, the `hermes-agent` venv (excluding `.git`, cache files, and personal data), and the tool store.
7. Ensures `PORTABLE` marker, directory layout, and offline environment variables are in place.

## How to use on another computer

1. Copy the entire `dist\HermesPortable` folder to any drive or computer (e.g. `C:\HermesPortable`, `E:\HermesPortable`, USB drive).
2. Double-click `Hermes.exe` inside that folder.
3. Set your provider and API key in the app Settings/Providers (DeepSeek, OpenAI, Anthropic, Gemini, Groq, etc.).
4. Start chatting. Nothing will download, and nothing will touch `C:\Users\...\AppData` or Windows temp.

## Building from the GitHub repo

The repo holds everything `scripts/build-portable.ps1` needs, but not the built binaries (`dist/`, `Hermes.exe`). Rebuild them after cloning.

Committed build inputs:

- the desktop app source, the Go launcher in `scripts/portable-launcher`, and the build scripts
- `runtime/python`: the embedded CPython 3.14.0rc2
- `runtime/hermes/hermes-agent`: the agent checkout with its pre-installed `venv` (all API SDKs and the `sitecustomize.py` fix) and `node_modules`

The agent's own git history is not included. The checkout is `NousResearch/hermes-agent` at commit `9a0a162536`. Nothing else from `runtime/` is committed: no profiles, sessions, keys, logs, or Electron profile.

To build on another Windows machine, you need Git, Node.js with npm, and Go:

```powershell
git clone https://github.com/plaethos99/hermes-portable.git
cd hermes-portable
npm ci
powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1
```

The build script points `venv\pyvenv.cfg` at the cloned `runtime\python` and recreates the npm workspace junctions in the agent's `node_modules`. The result is `dist\HermesPortable\Hermes.exe`.

To commit changed build inputs, run `scripts/stage-portable.ps1`. It force-adds the two runtime folders (they sit inside the gitignored `runtime/`) and leaves out bytecode.
