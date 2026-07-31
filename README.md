# H3 Prompt Studio

A self-hostable, single-user workspace that combines a **versioned MiniMax H3
video-prompt library** with **asynchronous H3 generation jobs**. Create reusable
prompt templates, declare `{{variable}}` placeholders, render and validate before
submitting, then watch jobs progress through `queued → running → succeeded` (or
`failed`/`expired`) — all while MiniMax credentials stay server-side.

The product is a complete vertical slice: strict-TypeScript React/Vite UI, a
Node/Express REST API, SQLite persistence, a deterministic mock provider **and**
a real MiniMax-H3 V2 adapter behind one `VideoProvider` interface, server-side
polling, validation, and idempotency. It runs end-to-end with **no MiniMax key**
in deterministic mock mode and switches to the real server-side API when a key is
configured.

> Requirements live in [`docs/PRD.md`](docs/PRD.md). No API keys belong in this
> repository — MiniMax credentials are supplied to the server at runtime.

---

## Highlights

- **Versioned prompt library** — immutable versions, restore-as-new-head,
  duplicate, archive (never delete), full-text + tag/status filters.
- **H3 camera-motion chips** — one-click camera cues (Pan left/right, Push in,
  Pull out, Tracking shot, Static shot) insert at the prompt cursor in the
  generation composer, preserving surrounding text; the cue-augmented prompt is
  still validated through the H3 policy before submission.
- **Pure template engine** — `{{variable}}` parsing/rendering with name
  validation (letters, numbers, `_`, `.`, `-`), duplicate normalization, and
  rejection of blank/unresolved variables.
- **Honest H3 policy** — durations 4–15s, explicit non-adaptive aspect ratios,
  resolution represented as `2K` only, in one server-side policy module.
- **Two providers, one interface** — deterministic mock (success/failure/expired/
  provider_error/slow scenarios) and the real MiniMax H3 V2 adapter; selected by
  configuration, never falling back silently.
- **Async + idempotent** — jobs return immediately with a local id, the server
  polls the provider (not the browser), submissions are de-duplicated by an
  idempotency key, and same-key/different-payload is a conflict. Idempotency is
  **concurrency-safe**: a SQLite unique-key race resolves into reuse or a 409,
  never a generic 500, and the client keeps the same key after transient
  failures so a retry cannot create a paid duplicate.
- **Resilient restart** — on startup, queued/running jobs with no recorded
  provider task are moved to an explicit recoverable `failed` state so the
  poller never spins on them forever (see the *exactly-once boundary* note
  below).
- **Production artifacts** — multi-stage Docker image, Docker Compose, and
  Kubernetes manifests for namespace `jcode` with PVC, probes, and referenced
  (never embedded) secrets.

---

## Architecture

A pnpm workspace with three packages and strict TypeScript throughout:

```
packages/
  shared/   # contract: types, zod schemas, template engine, H3 policy, errors
  server/   # Node + Express REST API, SQLite, providers, poller
  client/   # React + Vite SPA (imports shared types only — never server impl)
```

- **Data model** — `prompts` (identity) are separate from immutable
  `prompt_versions`, and `generation_jobs` record the rendered prompt, params,
  provider task id, and outcome. Migrations run on startup and via
  `pnpm migrate`.
- **Provider isolation** — MiniMax lives behind a small `VideoProvider`
  interface (`create`/`query`). The real adapter builds the multimodal `content`
  array, sends `Authorization: Bearer …` server-side (never logged), and maps
  provider states/errors into the local state machine.
- **Polling** — a simple in-process poller advances non-terminal jobs with
  bounded retry/backoff; the browser polls the server's job endpoint, never the
  provider directly.
- **Single image** — in production the server serves the built client at `/` and
  the API at `/api`.

```
┌────────────┐   /api/*   ┌─────────────────────┐    HTTPS    ┌──────────────┐
│  React UI  │ ─────────▶ │  Express API        │ ─────────▶  │  MiniMax H3  │
│ (Vite)     │ ◀───────── │  SQLite + poller    │ ◀────────── │  (or mock)   │
└────────────┘  job state  └─────────────────────┘   states    └──────────────┘
```

---

## Prerequisites

- **Node.js ≥ 22** (uses the built-in experimental `node:sqlite` — no native
  add-ons required).
- **pnpm 10** (enable via `corepack enable`).
- Optionally Docker / Kubernetes for containerized deployment.

---

## Quick start (mock mode, no key)

```bash
corepack enable
pnpm install
pnpm --filter @h3/shared build   # build the shared contract once

# Terminal 1 — API on :3001 (mock provider, sample prompts seeded)
pnpm dev:server

# Terminal 2 — UI on :5173 (proxies /api to :3001)
pnpm dev:client
```

Open <http://localhost:5173>. The library is seeded with sample prompts. Open a
prompt, fill variables, save a new version, then **Generate from head** to submit
a mock generation and watch it poll to success.

To exercise failure paths from the UI, pick a **Mock scenario** in the composer
(failure / expired / provider_error / slow), or call the mock-only control:

```bash
curl -X PUT localhost:3001/api/debug/mock -H 'Content-Type: application/json' \
  -d '{"scenario":"failure"}'
```

---

## Camera-movement preset chips (composer)

MiniMax's H3 guide recommends camera-motion cues (pan, push/pull, tracking,
static). The generation composer offers them as keyboard-reachable chips so you
don't have to remember or retype the phrasing:

- Open a prompt version → **Generate from head** to reach the composer.
- The **Prompt** card lists the chips: **Pan left, Pan right, Push in, Pull out,
  Tracking shot, Static shot**. Each is a real button (`Tab` to reach, `Enter`/
  `Space` to activate) with a visible focus ring and a tooltip describing the
  motion.
- Activating a chip inserts its token at the current cursor (or replaces the
  current selection) without disturbing the surrounding text; before you place
  the cursor it appends at the end. You can then edit the prompt freely.
- While the prompt is untouched it mirrors the rendered template (filling a
  variable live-updates it). The first chip insert or manual edit freezes it as
  the source of truth; **Reset to rendered** re-syncs it from the variables.
- The exact text shown is what is generated, sent as a `prompt` override and
  still validated through the existing H3 request policy (the 7000-character
  limit, duration, ratio, and media rules) before submission.

The preset labels and inserted tokens live in one pure, tested module
(`packages/shared/src/cameraPresets.ts`) so they are not duplicated across the
UI.

---

## Using the real MiniMax H3 API

Real mode is selected by configuration and **fails visibly** when the key is
absent — it never silently falls back to mock.

```bash
export PROVIDER_MODE=minimax
export MINIMAX_API_KEY=sk-...        # server-side only; never commit
# optional: export MINIMAX_GROUP_ID=... MINIMAX_BASE_URL=https://api.minimaxi.com
pnpm dev:server
```

The adapter targets the official H3 V2 contract:

- `POST {MINIMAX_BASE_URL}/v2/video_generation` with model `MiniMax-H3`.
- The body uses top-level **`ratio`** (not `aspect_ratio`) and a multimodal
  `content[]` array: one text item (max **7000** rendered characters) plus
  independent media items, each tagged with a `role`:
  `{type:"image_url",image_url:{url},role:"first_frame|last_frame|reference_image"}`,
  `{type:"video_url",video_url:{url},role:"reference_video"}`,
  `{type:"audio_url",audio_url:{url},role:"reference_audio"}`.
- Status is queried at `GET …/v2/query/video_generation/{task_id}` (the task id
  is a path segment, URL-encoded). The nested `task.status` /
  `task.content.url` / `task.error` are parsed; provider HTTP errors use the
  OpenAI-style envelope `{error:{type,message,http_code}}` and are classified by
  `http_code` (400/401/402/422/429/500/529).
- A trailing slash on `MINIMAX_BASE_URL` is normalized automatically.

The H3 constraints are enforced **before** the request reaches the provider:
durations 4–15s, `resolution` 2K, and the conditional `ratio` + media rules
(text-to-video needs a concrete ratio; first/last-frame is `adaptive`; reference
mode may use either). Media cross-field rules are also enforced: first/last-frame
mode and reference media are mutually exclusive, `last_frame` requires
`first_frame`, and reference audio requires a reference image or video. See
`packages/shared/src/h3-policy.ts`.

---

## Environment variables

| Variable             | Default                       | Description                                                          |
| -------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `PROVIDER_MODE`      | `mock`                        | `mock` or `minimax`.                                                 |
| `MINIMAX_API_KEY`    | _(unset)_                     | Required for `minimax`. Read server-side only.                       |
| `MINIMAX_GROUP_ID`   | _(unset)_                     | Optional MiniMax group id.                                           |
| `MINIMAX_BASE_URL`   | `https://api.minimaxi.com`    | MiniMax API base URL.                                                |
| `PORT`               | `3001`                        | HTTP port.                                                           |
| `DB_PATH`            | `./data/h3-studio.db`         | SQLite file path (persist on a mounted volume in prod).              |
| `SEED_SAMPLES`       | `true` (mock) / `false` (minimax) | Seed sample prompts when the DB is empty. Defaults off in `minimax` mode unless explicitly enabled. |
| `POLL_INTERVAL_MS`   | `2000`                        | Poller sweep interval.                                               |
| `POLL_MAX_ATTEMPTS`  | `120`                         | Consecutive provider failures before a job is marked failed.         |
| `CLIENT_DIST`        | _(unset in dev)_              | Built client dir to serve (set by Docker for the single image).      |

A starter template is in [`.env.example`](.env.example).

---

## NPM scripts

Run from the repository root:

| Command              | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `pnpm install`       | Install all workspace dependencies.                                |
| `pnpm -r run build`  | Production build of shared, server, and client.                    |
| `pnpm -r run typecheck` | Type-check every package (strict).                              |
| `pnpm lint`          | ESLint across the workspace.                                       |
| `pnpm -r run test`   | Run the full test suite (Vitest).                                  |
| `pnpm dev:server`    | Run the API in dev mode (tsx watch).                              |
| `pnpm dev:client`    | Run the Vite dev server.                                           |
| `pnpm migrate`       | Apply SQLite migrations (idempotent; also runs on startup).        |

> The server/test scripts set `NODE_OPTIONS=--experimental-sqlite` because
> `node:sqlite` is experimental in Node 22.

> `pnpm typecheck` and `pnpm test` build `@h3/shared` first so they work on a
> clean checkout with no `dist/` present; `pnpm -r run build` builds in
> topological (deterministic) order: shared → server/client.

---

## Testing

The gate is: install → lint → type check → all tests → production build.

```bash
pnpm -r run test
```

Coverage by intent (behavior and state transitions, not internals):

- **Template engine & validation** — parsing/rendering, variable-name rules,
  duplicate normalization, blank/unresolved rejection, and H3 duration (4/15
  boundaries) + all aspect ratios + http(s) URL validation.
- **MiniMax mapping** — request payload (`content` array), task-status → local
  state, and HTTP error → category mapping through a **fake HTTP transport**
  (no paid calls).
- **Mock provider** — deterministic queued→running→succeeded/failed/expired
  transitions, stable result URLs, create-time `provider_error`.
- **Repositories** — SQLite create/search/version-restore/archived behavior and
  the idempotency-key uniqueness constraint.
- **Generation service & poller** — idempotent reuse vs. conflict, unresolved
  variables, and the queued→terminal job lifecycle.
- **API (supertest)** — the core path: create prompt → version → render → submit
  mock generation → poll to success → history; plus validation, conflict, and
  request-id envelopes.
- **Components (RTL)** — empty library, populated cards, missing-variable submit
  protection, double-submit protection, and provider-failure rendering.

---

## REST API

All routes are under `/api` and return a consistent typed error envelope
`{ error: { code, message, status, requestId } }` on failure.

| Method | Path                                            | Purpose                                  |
| ------ | ----------------------------------------------- | ---------------------------------------- |
| GET    | `/api/health`                                   | App health vs. provider configuration.   |
| GET    | `/api/prompts`                                  | List/search/filter prompts.              |
| POST   | `/api/prompts`                                  | Create a prompt + first version.         |
| GET    | `/api/prompts/:id`                              | Prompt detail + version history.         |
| PATCH  | `/api/prompts/:id`                              | Update name/description/tags/status.     |
| POST   | `/api/prompts/:id/duplicate`                    | Duplicate a prompt.                      |
| DELETE | `/api/prompts/:id`                              | Archive a prompt (never hard-delete).    |
| POST   | `/api/prompts/:id/versions`                     | Save a new immutable version.            |
| POST   | `/api/prompts/:id/versions/:vid/restore`        | Restore a version as a new head.         |
| POST   | `/api/render-preview`                           | Render a template with values.           |
| GET    | `/api/generations`                              | List jobs (filter by status/prompt).     |
| POST   | `/api/generations`                              | Submit a generation (idempotent).        |
| GET    | `/api/generations/:id`                          | Job detail (rendered prompt, outcome).   |
| POST   | `/api/generations/:id/retry`                    | Retry a failed/expired job as new.       |
| GET/PUT| `/api/debug/mock`                               | Mock-only scenario control.              |

Example submission:

```bash
curl -X POST localhost:3001/api/generations -H 'Content-Type: application/json' -d '{
  "promptVersionId": "<version-id>",
  "values": { "subject": "a car" },
  "durationSeconds": 6,
  "aspectRatio": "16:9",
  "resolution": "2K",
  "idempotencyKey": "unique-per-attempt"
}'
```

---

## Docker

Build and run the single production image (API + client) with Docker Compose:

```bash
docker compose up --build
# open http://localhost:3001
```

The runtime image runs as a named, unprivileged user (`h3`, fixed UID/GID
`10001`) that owns `/data`, so SQLite data is persisted on the `h3-data` volume
and the process never runs as root. To use the real provider with Compose, set
`PROVIDER_MODE=minimax` and inject `MINIMAX_API_KEY` via your secret mechanism
(not committed).

> The committed image tag is a **local convenience** (`h3-prompt-studio:latest`).
> For production, build once, push to your registry, and deploy an **immutable**
> reference — a specific tag or, preferably, a digest (`image:
> registry.example.com/h3-prompt-studio@sha256:…`), overriding the Deployment
> image via `kubectl set image` or a kustomize `images:` entry. Do not treat a
> mutable `:latest` as production-ready.

---

## Kubernetes (namespace `jcode`)

Manifests live in [`k8s/`](k8s/): Namespace, ConfigMap, PVC, Deployment
(readiness/liveness probes, `Recreate` strategy for single-instance SQLite), and
a ClusterIP Service. **No Secret is committed or applied** — see below.

The Deployment is hardened: it runs as the same non-root UID/GID (`10001`) baked
into the image, with `runAsNonRoot`, `allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true`, all Linux capabilities dropped, and the
`RuntimeDefault` seccomp profile. The only writable path is the mounted `/data`
PVC (SQLite + WAL); no `/tmp` emptyDir is needed.

```bash
docker build -t h3-prompt-studio:latest .   # for production, push an immutable tag/digest
kubectl apply -k k8s/
kubectl -n jcode rollout status deploy/h3-prompt-studio
kubectl -n jcode port-forward svc/h3-prompt-studio 8080:80   # open http://localhost:8080
```

**Credentials are supplied out-of-band only** — there is deliberately no
committed Secret, so `kubectl apply -k k8s/` can never overwrite an operator's
real MiniMax key with a placeholder. In mock mode the Deployment's `secretRef` is
`optional: true` and the pod starts with no secret present. For real mode:

```bash
kubectl -n jcode create secret generic h3-prompt-studio-secrets \
  --from-literal=MINIMAX_API_KEY=sk-... -o yaml --dry-run=client | kubectl apply -f -
# then set PROVIDER_MODE=minimax (e.g. patch the ConfigMap) and roll the Deployment.
```

> Never commit a real key. `kubectl apply -k k8s/` applies no Secret resource at
> all.


---

## Security notes

- MiniMax credentials are read from the environment **server-side only**. They
  never appear in client bundles, API responses, logs, or Git. Authorization
  headers and rendered media payloads are never logged.
- External media URLs are validated as `http(s)`. Production deployments should
  add **URL allowlists and server-side media ingestion** rather than passing
  arbitrary provider-side fetches — this is the documented extension point for
  SSRF/media scanning.
- Health (`/api/health`) distinguishes application health from provider
  configuration: a missing paid key is reported as `degraded` (and
  `providerConfigured: false`), not an outage. `/api/healthz` (liveness) is
  always `200 ok`; `/api/health` (readiness) returns `200` so traffic still
  flows while the key is absent.
- Inbound `X-Request-Id` headers are validated against a bounded, control-free
  safe character set; an unsafe or overlong value is replaced with a generated
  id (no header/log injection). In `minimax` mode, sample seeding defaults off
  unless explicitly enabled.
- **Exactly-once boundary (documented).** This single-instance PoC stores a job
  row *before* submitting to the provider. If the process is interrupted after
  the provider accepted a request but before the task id was persisted, the
  provider may have started a generation the local row does not know about.
  Startup recovery moves such orphaned rows to a recoverable `failed` state;
  retrying creates a new local job (and may create a second provider
  generation). Closing this gap would require a durable outbox plus provider
  idempotency — the documented extension point.

## Extensibility points (out of scope for this PoC)

- Replace the in-process poller with a **durable distributed queue** and
  horizontal multi-instance polling.
- Add **webhooks** for provider callbacks.
- Add SSRF allowlists / media scanning before provider fetches.
- The provider seam (`packages/server/src/providers`) is where additional video
  providers would be added.

---

## Project layout

```
docs/PRD.md              Product requirements
k8s/                     Namespace jcode Kubernetes manifests
packages/shared          Types, zod schemas, template engine, H3 policy, errors
packages/server          Express API, SQLite, providers, poller, migrations
packages/client          React/Vite SPA and typed API client
Dockerfile               Multi-stage production image
docker-compose.yml       Local containerized run
```

## License

Provided for the Cloud dogfood exercise described in `docs/PRD.md`.
