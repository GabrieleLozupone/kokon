# Local HTTP API

Kokon's service listens on `127.0.0.1` only. The desktop app, the MCP server and your own scripts
all use it. The routes below are the ones registered in
[`crates/qls-service/src/api.rs`](../crates/qls-service/src/api.rs); request bodies are JSON unless
a row says otherwise.

## Base URL and token

The service writes its port and token to `service.json` when it starts:

| System | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\KokonData\service.json` |
| Mac | `~/Library/Application Support/KokonData/service.json` |

Base URL: `http://127.0.0.1:<port>/api/v1` (the port is usually `39151`). Every call except
`/ping` needs `Authorization: Bearer <token>`. Requests that carry a browser `Origin` header are
refused. Errors come back as `{"error": {...}}`.

**PowerShell:**

```powershell
$i = Get-Content "$env:LOCALAPPDATA\KokonData\service.json" | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($i.token)" }
Invoke-RestMethod -Method Post "http://127.0.0.1:$($i.port)/api/v1/generate" -Headers $h `
  -ContentType 'application/json' -Body '{"prompt":"a lighthouse at dusk, 16:9","quality":"fast"}'
```

**macOS (curl):**

```bash
INFO="$HOME/Library/Application Support/KokonData/service.json"
TOKEN=$(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$INFO")
PORT=$(sed -n 's/.*"port" *: *\([0-9]*\).*/\1/p' "$INFO")

curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/v1/status"

curl -s -X POST "http://127.0.0.1:$PORT/api/v1/generate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"a lighthouse at dusk, 16:9","quality":"fast"}'
```

Kokon has to be running, or `kokon-service` started, for `service.json` to exist and be current.

## Status and settings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ping` | Liveness check (no token needed) |
| GET | `/status` | Server state, model, GPU and VRAM, active job, queue |
| GET | `/jobs` | List the jobs the service knows about |
| GET, PUT | `/config` | Read or replace the app settings; the reply to PUT says whether the backend must restart |
| GET | `/diagnostics` | GPUs, backend status and version, and detected devices as JSON |
| GET | `/logs?lines=200` | Tail of the backend log (default 200 lines, at most 4000) |
| GET | `/enhancer/defaults` | The built-in system prompts for Prompt+ |

## Generating

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/generate`, `/edit`, `/inpaint`, `/outpaint`, `/upscale` | Simple operations; wait for the result unless `?wait=false` |
| POST | `/jobs` | Full request (see `GenerationRequest` in `planner.rs`) |
| GET | `/jobs/{id}` | Job status |
| GET | `/jobs/{id}/wait?timeout=60` | Long-poll until the job finishes |
| POST | `/jobs/{id}/cancel` | Cancel a job |
| POST | `/plan` | Dry run: resolved mode, working and output size, notes |
| GET | `/events` | Server-sent events (jobs, server, gallery) |

Simple-operation fields: `prompt`, `image` / `images[]`, `mask`, `action`
(`edit|remove|replace|add`, inpainting), `width`, `height`, `aspect_ratio`, `quality`
(`fast|balanced|quality`), `seed`, `output_path`, `preserve_dimensions`, `private`,
`left/right/top/bottom` + `units` (`pixels|percent`) for outpainting, `scale` for upscaling.
Full requests (`/jobs`) also accept `"mode": "upscale"` with `"upscale": {"scale" | "width"/"height"}`.

## Input images

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/inputs` | Upload an image: raw bytes as the body, optional percent-encoded `X-Filename` header, `?private=true` for private mode. Up to 210 MB |
| POST | `/inputs/import` | Import an image from a path on this machine: `{"path": "..."}`; `?private=true` is allowed |
| GET | `/inputs/{id}` | The stored input's record |
| GET | `/inputs/{id}/image`, `/inputs/{id}/thumb` | The image, or its thumbnail |
| POST | `/image-info` | Size, aspect, type and embedded generation metadata of an image |
| POST | `/private/clear` | End private mode: delete every private input and result |

## Gallery

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/gallery` | List results, see the query parameters below. Replies `{"items": [...], "total": n}` |
| GET | `/gallery/{id}` | One result with its recipe |
| PATCH | `/gallery/{id}` | Change a result; today only `{"favorite": true|false}` |
| DELETE | `/gallery/{id}` | Delete a result and its files |
| GET | `/gallery/{id}/image` | The result image |
| GET | `/gallery/{id}/thumb` | Its thumbnail |
| GET | `/gallery/{id}/original` | The result before the upscaler enlarged it, when it was kept |
| POST | `/gallery/{id}/export` | Save a copy to a path: `{"path": "...", "overwrite": false, "original": false}`; the format follows the file extension |

`GET /gallery` query parameters (all optional):

| Parameter | Meaning |
| --- | --- |
| `q` | Text to search for |
| `favorites` | `true` to list only favorites |
| `limit`, `offset` | Paging |
| `sort` | `recent` (default) or `oldest` |

## Models, upscalers, LoRAs and LUTs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/models` | The active model's files, what is missing and what can be done about it |
| POST | `/models/scan`, `/models/inspect` | List the model files in a folder (sub-folders included) with the suggested file for each role; inspect one file by `{"path": "..."}` |
| POST | `/models/user`, `/models/use` | Save your own model files as a profile; switch between the official files and yours |
| POST | `/models/vae` | Download the texture-fix VAE and make the active model use it (progress in `/setup/install`) |
| GET | `/upscalers` | The upscalers Settings offers and whether each is installed |
| POST | `/upscalers/{name}/download` | Download one upscaler (progress in `/setup/install`) |
| GET, POST | `/loras` | List LoRAs; add one from a path: `{"path": "..."}` (copied into Kokon's LoRA folder) |
| PATCH, DELETE | `/loras/{id}` | Update or remove a LoRA |
| GET | `/luts` | List the color LUTs |
| POST | `/luts/import` | Add a `.cube` file from a path: `{"path": "..."}` |
| DELETE | `/luts/{name}` | Remove a LUT |
| GET | `/luts/{name}/preview?source=gen:<id>&max=<px>` | The LUT at full strength on a result (`gen:<id>`) or imported image (`input:<id>`), reduced to `max` pixels (256 to 4096), for a live preview |
| POST | `/luts/{name}/apply` | Save the image with the LUT applied as a new version, keeping the source: `{"source": "gen:<id>", "intensity": 1.0, "private": false}` |
| POST | `/examples` | Add the bundled example projects and list them |

## Internal routes

These exist for the desktop app's setup screen and its lifecycle. Scripts should not need them,
and they may change between versions.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/setup`, `/setup/hardware` | First-run state; hardware and download presets |
| GET, POST | `/setup/install` | Install progress; start an install |
| POST | `/setup/install/cancel`, `/setup/gpu` | Cancel an install; run the engine on another graphics card |
| GET, DELETE | `/setup/legacy-upscalers` | List or remove upscalers from older versions |
| POST | `/backend/start`, `/backend/stop`, `/backend/restart` | Control the inference server |
| POST | `/session/heartbeat`, `/session/release` | A client registers or drops its lease on the service |
| POST | `/shutdown` | Stop the service |
