# Changelog

All notable **user-visible** changes to H3 Prompt Studio are documented here.
Engineering-only changes (refactors, tests, internal hardening, deployment
posture) are tracked in the dated reports under [`docs/reports/`](docs/reports/).

This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **MiniMax provider corrected to the current official API contract** — the real
  provider now targets `MiniMax-Hailuo-2.3` on the official `/v1` general video
  API: flat `POST /v1/video_generation` body (`model`, `prompt`, `duration`,
  `resolution`, optional `first_frame_image`); `GET /v1/query/video_generation
  ?task_id=…` with flat status mapping (`Preparing`/`Queueing` → queued,
  `Processing` → running, `Success` → succeeded, `Fail` → failed); on success the
  returned `file_id` is resolved via `GET /v1/files/retrieve?file_id=…` and
  `file.download_url` is surfaced. Nonzero `base_resp.status_code` is a typed
  provider failure. The obsolete `MiniMax-H3` / `/v2` multimodal `content[]` /
  `ratio` contract is no longer sent.
- **Hailuo-2.3 constraints enforced** — `prompt` ≤ 2000 characters; `duration` 6
  or 10 seconds; `resolution` `768P` or `1080P` (10 seconds only at `768P`).
  Text-to-video and first-frame image-to-video are supported; last-frame and
  reference image/video/audio inputs are not supported by this model and are now
  rejected by the API schema (with a visible message). The composer no longer
  offers an aspect-ratio control. Historical stored jobs remain readable; the
  `aspect_ratio` column is retained for backward compatibility.
- **Default `MINIMAX_BASE_URL`** is now `https://api.minimax.io`.

### Added

- **Camera-movement preset chips** in the generation composer — Pan left,
  Pan right, Push in, Pull out, Tracking shot, and Static shot. Each chip
  inserts its cue at the prompt cursor (replacing a selection, or appending at
  the end before the cursor is placed) without disturbing surrounding text,
  then the cue-augmented prompt is still validated through the H3 policy
  (character limit, duration, ratio, media rules) before submission. Chips are
  keyboard-reachable with visible focus and are disabled until every variable is
  resolved. (`389ce61`, 2026-07-31)

## [1.0.0] - 2026-07-31

Initial release of H3 Prompt Studio — a self-hostable, single-user workspace
combining a versioned MiniMax Hailuo video-prompt library with asynchronous
generation jobs. Runs end-to-end with no MiniMax key in deterministic mock mode
and switches to the real server-side API when a key is configured.
(`f41af8c`, 2026-07-31)

### Added

- **Versioned prompt library** — title, description, tags, and lifecycle status;
  immutable prompt versions; restore-as-new-head; duplicate; archive (never
  hard-delete); full-text + tag/status search and filtering.
- **Template engine** — `{{variable}}` placeholders auto-detected into editable
  forms, live render preview, and validation of missing variables and render
  errors before submission.
- **Generation composer** — MiniMax-Hailuo-2.3 parameters: durations 6 or 10
  seconds, `768P`/`1080P` resolution (10s only at `768P`), and an optional
  first-frame image-to-video URL input.
- **Async, idempotent generation jobs** — requests return immediately with a
  local job id; `queued → running → succeeded` (or `failed`/`expired`) states
  with automatic status refresh; submissions de-duplicated by an idempotency key
  (same key + different payload is a conflict).
- **Provider error translation** — provider failures mapped to useful messages
  (authentication, balance, moderation, rate-limit, provider) while retaining
  the request id; failed/expired jobs retryable as new jobs.
- **Auditable generation history** — each job records the immutable prompt
  version, rendered prompt, parameters, provider task id, timestamps, and
  outcome.
- **Two providers** — a deterministic mock (seeded sample prompts; success,
  failure, expired, provider-error, and slow scenarios) and the real
  MiniMax-Hailuo-2.3 adapter; selected by configuration with no silent fallback
  to mock.
- **Health endpoint** distinguishing application health from provider
  configuration (a missing paid key is reported as `degraded`, not an outage).
- **Production deployment artifacts** — multi-stage Docker image, Docker
  Compose, and Kubernetes manifests for namespace `jcode` with persistent
  SQLite storage, probes, and non-root hardening.
