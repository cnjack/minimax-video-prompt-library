# PRD: H3 Prompt Studio

## Problem Statement

Video teams repeatedly rewrite MiniMax Hailuo prompts in documents and chat, lose
which prompt produced a useful result, and have no safe place to manage the
asynchronous generation lifecycle. A product builder needs one local,
self-hostable workspace where prompts are reusable assets, generations are
traceable, and API credentials never reach the browser or repository.

## Solution

Build **H3 Prompt Studio**, a single-user web application that combines a
versioned video-prompt library with MiniMax Hailuo generation jobs. A user can
create and search prompt templates, declare and fill variables, preview the
rendered prompt, submit a valid MiniMax Hailuo job, observe its state, and revisit
the output and exact prompt version later.

The PoC must be a complete, polished vertical slice that runs locally without a
MiniMax key in deterministic mock mode and switches to the real server-side API
when a key is configured.

## User Stories

1. As a video creator, I want to create a named prompt template, so that I can reuse a successful creative direction.
2. As a video creator, I want a title, description, tags, and lifecycle status, so that a growing library remains understandable.
3. As a video creator, I want to use `{{variable}}` placeholders, so that one template can cover many subjects and settings.
4. As a video creator, I want variables detected automatically and editable in a form, so that I do not manually synchronize template metadata.
5. As a video creator, I want to preview the final rendered prompt before submission, so that mistakes do not spend generation credits.
6. As a video creator, I want validation for missing variables, prompt content, duration, and resolution, so that invalid requests fail before reaching MiniMax.
7. As a video creator, I want each meaningful prompt edit saved as a new immutable version, so that past generations remain reproducible.
8. As a video creator, I want to see version history and restore an old version as a new head, so that experimentation is reversible.
9. As a video creator, I want full-text search and tag/status filters, so that I can find a prompt quickly.
10. As a video creator, I want to duplicate a prompt, so that I can explore a variation without overwriting the original.
11. As a video creator, I want to archive rather than destroy prompts by default, so that generated work does not lose its context.
12. As a video creator, I want a focused generation composer launched from a prompt version, so that the library and creation workflow feel connected.
13. As a video creator, I want to choose a Hailuo duration of 6 or 10 seconds
    and a supported resolution (`768P`/`1080P`), so that the request matches the
    official MiniMax-Hailuo-2.3 API contract.
14. As a video creator, I want invalid duration/resolution combinations (10 seconds only at 768P) rejected before submission, so that server-side validation catches a MiniMax-Hailuo-2.3 API incompatibility.
15. As a video creator, I want resolution represented honestly as 768P or 1080P, so that the interface does not advertise unsupported choices.
16. As a video creator, I want an optional first-frame image-to-video URL input (and unsupported last-frame / reference media visibly disabled), so that I can use the Hailuo-2.3 image-to-video control without uploading secrets through the browser.
17. As a video creator, I want a generation request to return immediately with a local job identifier, so that a slow provider does not block the UI.
18. As a video creator, I want queued, running, succeeded, failed, and expired states shown clearly, so that I know whether to wait or act.
19. As a video creator, I want automatic status refresh with a visible last-updated time, so that progress is understandable without reloading.
20. As a video creator, I want provider errors translated into useful messages while retaining a request ID, so that I can diagnose authentication, balance, moderation, rate-limit, and provider failures.
21. As a video creator, I want successful output playable or linkable from history, so that I can inspect the result.
22. As a video creator, I want generation history to record the immutable prompt version, rendered prompt, parameters, provider task ID, timestamps, and outcome, so that results are auditable.
23. As a video creator, I want to retry a failed generation as a new job, so that history remains truthful.
24. As a video creator, I want duplicate submissions protected by an idempotency key, so that double-clicks do not spend credits twice.
25. As a local evaluator without a MiniMax key, I want a deterministic mock provider with realistic transitions, success, and failure scenarios, so that I can test the entire product safely.
26. As an operator, I want the MiniMax key read only by the backend from environment configuration, so that it never appears in frontend assets, API responses, logs, or Git.
27. As an operator, I want a health endpoint that distinguishes application health from provider configuration, so that a missing paid API key does not masquerade as an outage.
28. As an operator, I want SQLite data persisted on a mounted volume, so that local prompt and job history survives restarts.
29. As an operator, I want one-command local startup and documented environment variables, so that the PoC is reproducible.
30. As an operator, I want a production Docker image and Kubernetes manifests for namespace `jcode`, so that the same build can be deployed locally.
31. As a reviewer, I want tests for prompt rendering/versioning, validation, idempotency, provider mapping, job transitions, and key API flows, so that failures are caught without calling the paid service.
32. As a reviewer, I want type checking, linting, tests, and production builds to pass, so that the pull request is reviewable rather than a demo fragment.
33. As a first-time user, I want useful sample prompts in mock mode and strong empty/loading/error states, so that I understand the product immediately.
34. As a first-time user, I want a responsive, accessible interface with keyboard-reachable controls and visible focus, so that the tool feels production-ready.
35. As a video creator, I want a transient provider read-path failure (a rate-limit,
    a `Success` briefly missing its `file_id`, or a file-retrieve briefly missing its
    `download_url`) to keep my already-paid job retrying instead of terminal-failing
    it, so that a temporary blip never forces a second paid generation.
36. As a video creator, when tracking an already-paid job has paused after repeated
    transient failures, I want a Resume action that re-checks the SAME provider task
    without spending another generation, so I never have to pay again to recover a
    job that may still be alive. A genuine provider failure should still be clearly
    terminal with a Regenerate action.

## Implementation Decisions

- Use a TypeScript workspace with a React/Vite client and Node REST API. Keep it
  a modular monolith with feature-first boundaries rather than separate
  services.
- Use SQLite as the source of truth. Model prompt identity separately from
  immutable prompt versions and generation jobs. Migrations must run safely on
  startup or through an explicit documented command.
- Define shared runtime schemas for request and response validation. The client
  consumes a small typed API module; it must not import server implementation.
- Isolate template parsing/rendering as a deep, pure module. Support variable
  names made from letters, numbers, underscore, dot, and hyphen; normalize
  duplicates; reject blank names and unresolved variables.
- Isolate the MiniMax integration behind a `VideoProvider`-style interface with
  create/query operations. Provide both real MiniMax and deterministic mock
  adapters selected by server configuration.
- The real adapter targets the official MiniMax-Hailuo-2.3 general video
  endpoint (`POST /v1/video_generation`), uses model `MiniMax-Hailuo-2.3`, sends
  a flat request body (`prompt`, `duration`, `resolution`, optional
  `first_frame_image`), sends credentials as server-side authorization, queries
  `GET /v1/query/video_generation?task_id=…`, resolves the result via
  `GET /v1/files/retrieve?file_id=…`, and maps provider task states into the
  local job state machine.
- Poll provider state from the server, not the browser directly. Ensure only
  non-terminal jobs are polled, apply bounded retry/backoff, and make repeated
  polling idempotent. A simple in-process poller is sufficient for this
  single-instance PoC.
- Expose REST resources for prompts, versions, generation jobs, health, and
  mock-only scenario control where useful. Return consistent typed error
  envelopes with stable codes and request IDs.
- Accept an idempotency key on generation creation and enforce uniqueness in
  storage. The same key with a different payload must return a conflict rather
  than silently reuse a job.
- Default to mock mode. Real mode must fail visibly at startup or generation
  time when `MINIMAX_API_KEY` is absent; never fall back silently from real to
  mock.
- Do not log authorization headers, rendered media payloads, or secrets.
  External URLs must be validated as HTTP(S); document that production systems
  should add allowlists and media ingestion rather than arbitrary provider-side
  fetches.
- Use a clean visual system appropriate for a creative production tool, with a
  library view, prompt editor/version history, generation composer, and job
  history/detail view. Avoid generic admin-dashboard styling.
- Provide a multi-stage production image, Docker Compose for local use, and
  Kubernetes Namespace/Deployment/Service/PVC manifests targeting `jcode`.
  Secrets are referenced, never embedded. Include readiness/liveness probes and
  persistent SQLite storage.
- Keep official API constraints in one server-side policy module and document
  the source so they can be updated without editing UI logic in multiple places.

## Testing Decisions

- Test externally visible behavior and state transitions, not private function
  calls or framework details.
- Unit-test template variable detection/rendering and Hailuo-2.3 request validation
  with boundary values, including 6/10 durations, 768P/1080P resolution, the
  2000-character prompt limit, and the 10s-only-at-768P rule.
- Unit-test MiniMax request mapping and provider error/state mapping through a
  fake HTTP transport; paid API calls are forbidden in automated tests.
- Integration-test SQLite repositories, version restore semantics, archived
  behavior, generation idempotency, and the queued-to-terminal job lifecycle.
- API-test the core path: create a prompt, create a new version, render
  variables, submit a mock generation, poll to success, and retrieve history.
- Component-test the highest-risk UI states: missing variables, submit
  protection, provider failure, empty library, and successful output.
- The delivery gate is: dependency install, lint, type check, all tests, and
  production client/server build. Document exact commands and run them.

## Out of Scope

- Multi-user accounts, organizations, RBAC, billing, credit purchase, or quota
  management.
- Hosting uploaded media, transcoding, editing timelines, or training models.
- A durable distributed queue, horizontal multi-instance polling, webhooks, or
  production-grade SSRF/media scanning. The design should expose where those
  capabilities would be added.
- Deleting provider-side jobs, social publishing, prompt marketplace commerce,
  or automatic prompt optimization by another LLM.
- Running a paid real MiniMax generation during CI or this dogfood exercise.

## Further Notes

- Official API source of truth (current): the MiniMax-Hailuo-2.3 general video
  API — `POST https://api.minimax.io/v1/video_generation`,
  `GET /v1/query/video_generation?task_id=…`, and
  `GET /v1/files/retrieve?file_id=…`. It returns a flat provider `task_id`, uses
  asynchronous query with statuses `Preparing`/`Queueing`/`Processing`/`Success`/
  `Fail` (mapped to local queued/running/succeeded/failed), carries a `base_resp`
  whose nonzero `status_code` is a typed error, and resolves the result
  `file.download_url` from the `file_id` returned on success.
- **Migration note (legacy H3 contract).** An earlier draft of this product
  targeted the obsolete `MiniMax-H3` / `/v2` multimodal `content[]` contract
  (arbitrary 4–15s durations, `ratio`, `2K` resolution, last-frame and reference
  media). None of that is sent or accepted for new jobs anymore; the only
  remnant is the retained `aspect_ratio` database column, which keeps historical
  stored jobs readable (new jobs store the `native` sentinel).
- The supplied coding-model credential is unrelated to MiniMax video-generation
  credentials. The application must work end-to-end in mock mode until a
  separate `MINIMAX_API_KEY` is supplied.
- This repository also contains developer, PM, and architect custom-agent
  profiles. The initial product build intentionally uses Cloud's built-in agent;
  the profiles are evidence for later workflow-selection tests.
