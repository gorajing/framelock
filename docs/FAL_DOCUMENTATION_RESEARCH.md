# fal documentation research for FrameLock

## Complete indexed-corpus review and live-catalog supplement

| Field | Value |
|---|---|
| Research date | July 17, 2026 |
| Primary source | fal's declared complete documentation index at `https://fal.ai/docs/llms.txt` |
| Indexed documents downloaded | 418 |
| Total snapshot size | 6,033,932 bytes |
| Total snapshot lines | 155,101 |
| Empty files | 0 |
| HTML fallback/error files | 0 |
| Exact duplicate file hashes | 0 |
| Authored conclusion | Use fal for generation and optional mask candidates; keep deterministic restoration and verification in FrameLock |

---

## 1. Executive findings

The fal platform is strong enough to build FrameLock within the hackathon, but the product must not outsource its guarantee to a model.

The documentation supports five central conclusions:

1. **Use Model APIs, not a custom GPU deployment, on the critical path.** The Model API queue, SDKs and storage primitives are immediately useful. fal Serverless and Compute are powerful but access and operational setup can be gated.
2. **Use queue-backed asynchronous jobs for video.** Durable request IDs, status, logs, cancellation and retries matter more than the lowest possible request overhead.
3. **Treat masks, generation and verification as different authorities.** A segmentation model proposes the protected region. A video model creates the new scene. FrameLock deterministically restores and audits the declared protected core.
4. **Prefer mask-conditioned video inpainting if its live test passes.** The live catalog contains `fal-ai/ltx-2.3-quality/inpaint`, which accepts a source video plus a mask where white regions regenerate and black regions preserve source content. This is a closer architectural match than full-frame video-to-video editing.
5. **Keep Kling O3 as the high-creativity fallback.** Kling O3 is well suited to dramatic video transformation, but its documentation does not guarantee frame count, timing, geometry or unchanged pixels.

The recommended experimental model chain is therefore:

```text
Source video
  -> semantic or foreground temporal mask
  -> invert mask so background is white and protected object is black
  -> LTX 2.3 Quality video inpainting
  -> deterministic canonical source-sample restoration in protected core
  -> independent canonical-frame audit
```

Fallback chain:

```text
BiRefNet foreground mask
  -> Kling O3 Standard video-to-video edit
  -> comparability check and alignment
  -> deterministic restoration
  -> audit
```

The model never earns the green “Verified” badge. FrameLock's audit does.

For hackathon P0, the temporal mask is a prepared static grayscale mask repeated across the exact canonical timeline. BiRefNet, SAM 3 and SA2VA are research candidates, not prerequisites for the first end-to-end proof.

### 1.1 Live implementation outcome

The documentation-led feasibility sequence produced a narrower implementation decision:

- Authenticated LTX pricing was `$0.0024075` per megapixel. Attempt 1 cost estimate was `$0.268468992`, but its 1280×768, 5:3 result failed the 16:9 hard gate.
- Kling O3 Standard Edit was tested once as the allowed fallback. Its authenticated price was `$0.14` per second and the 5.041667-second estimate was `$0.705833`. The result met 1280×720, 121-frame and 24/1 timing requirements.
- Kling's edit schema did not provide mask, seed, output-resolution or FPS controls. FrameLock therefore treats its full-frame output as untrusted generated media, then applies local comparability, restoration and verification.
- The Kling file omitted primary color metadata. The canonical decoder records an explicit `explicit_bt709_limited_fallback` assumption rather than describing BT.709 limited range as source-declared fact.
- `@fal-ai/client` 1.10.1 retries queue submissions internally. Because fal exposes no documented idempotency key for this paid request, FrameLock uses one native queue POST with `X-Fal-No-Retry: 1` and fallback disabled. An ambiguous response becomes terminal `submission_unknown` and is never retried automatically.
- The app captures immutable attempt and authenticated pricing evidence before upload. A global local-store lock performs a fresh budget scan and reservation atomically, so concurrent jobs cannot both consume the final authorized attempt.
- SDK storage upload plus read-only status and result calls remain useful. The ADMIN credential is not required or used.
- Model audio is disabled and never trusted as source audio. The preview uses only the source track normalized to the declared 48 kHz stereo PCM contract; audio remains outside the protected-pixel claim.

The selected live request is `019f72e4-5e1e-7143-bf91-e3aac20328da`. These results validate the generator choice for the synthetic proof only; they do not establish commercial realism or a general model guarantee.

---

## 2. Research scope and method

### 2.1 Official indexed corpus

The root documentation page instructs readers and agents to use [`https://fal.ai/docs/llms.txt`](https://fal.ai/docs/llms.txt) as the complete documentation index. We downloaded every unique `https://fal.ai/docs/...` URL from that file and verified the resulting corpus.

| Section | Files | Lines | Bytes |
|---|---:|---:|---:|
| `documentation` | 112 | 20,652 | 924,939 |
| `api-reference` | 68 | 49,545 | 1,929,959 |
| `platform-apis` | 71 | 33,505 | 1,230,872 |
| `model-api-reference` | 138 | 42,892 | 1,631,984 |
| `examples` | 28 | 7,318 | 248,293 |
| `changelog.md` | 1 | 1,189 | 67,885 |
| **Total** | **418** | **155,101** | **6,033,932** |

Formats:

- 416 Markdown documents
- 2 OpenAPI JSON schemas
- 0 empty files
- 0 HTML fallback responses

Verification identifiers:

- Sorted relative-path inventory SHA-256: `0ecc967dbf8c56416b48ae945a5e00f9e15b8805dc489284348cc897fd53cea0`
- Original crawl's ordered per-file SHA-256 ledger digest: `2df9e54223d45a0097b12a7b5b249f7b95ee9458bf09cacd0592efa88e4db1a9`
- Independently recomputed sorted `hash + relative path` stream digest: `4d690517f0060be39925d28d087cd75732f4489f1de3b56c47e295cc7e7c79e9`

Recompute the two independently verifiable identifiers from the repository root:

```bash
cd .firecrawl/fal-docs-pages
find . -type f | sed 's#^\./##' | LC_ALL=C sort | shasum -a 256
find . -type f | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done | shasum -a 256
```

The first command returns the inventory hash and the second returns the independently recomputed hash-and-path stream digest. The original crawl ledger digest is retained as historical run evidence, but the two commands above are the current reproducibility checks.

Local reproducible research cache:

- `../.firecrawl/fal-docs-llms.txt`
- `../.firecrawl/fal-doc-urls.txt`
- `../.firecrawl/fal-docs-pages/`
- `../.firecrawl/fal-live-model-schemas-2026-07-17.json`

### 2.2 Crawl-tool boundary

The Firecrawl CLI was available through `npx`, but no authenticated session or `FIRECRAWL_API_KEY` was present. Browser authentication was opened and expired without approval. We therefore did not claim a successful Firecrawl crawl.

Instead, we used fal's own declared complete index and downloaded every official page directly. This was sufficient for deterministic coverage accounting because the site itself exposes the canonical URL inventory.

### 2.3 Important coverage boundary

The 418-document corpus is the complete published docs index, but its 138 model-reference pages are a curated “top models” subset, not the full live catalog of 1,000+ endpoints.

That distinction matters. Several highly relevant live endpoints were absent from the curated model-reference section:

- `fal-ai/ltx-2.3-quality/inpaint`
- `fal-ai/void-video-inpainting`
- `fal-ai/sam-3/video`
- `fal-ai/sa2va/8b/video`

The documented [Platform Model Search API](https://fal.ai/docs/platform-apis/v1/models) permits public, unauthenticated catalog and schema discovery at lower rate limits. We used that API to supplement the indexed-corpus review. Inference and pricing still require a fal key.

The raw live response is saved at `../.firecrawl/fal-live-model-schemas-2026-07-17.json`. It contains four requested model records with expanded OpenAPI schemas, is 30,886 bytes and has SHA-256 `0ba8f6bed7865d45b07c5168f712e555c94b667cff84c8c4dc4272f61feddfa6`.

Reconstruct the public lookup with repeated query parameters:

```bash
curl --get 'https://api.fal.ai/v1/models' \
  --data-urlencode 'endpoint_id=fal-ai/ltx-2.3-quality/inpaint' \
  --data-urlencode 'endpoint_id=fal-ai/void-video-inpainting' \
  --data-urlencode 'endpoint_id=fal-ai/sa2va/8b/video' \
  --data-urlencode 'endpoint_id=fal-ai/sam-3/video' \
  --data-urlencode 'expand=openapi-3.0' \
  --data-urlencode 'expand=enterprise_status'
```

This lookup is reproducible without a key at fal's lower public rate limit. The pricing endpoint returned an authorization error, so this dossier does not invent current prices for the live-catalog models.

### 2.4 Evidence grades used in this dossier

- **Indexed documentation:** found in the 418-document official corpus.
- **Live schema:** retrieved from fal's public Platform Models API on July 17, 2026.
- **Needs run:** a model behavior that cannot be established from schema or prose.
- **FrameLock decision:** our implementation conclusion, not a claim made by fal.

---

## 3. Platform map

fal is best understood as four related surfaces.

### 3.1 Model APIs

Managed image, video, audio, vision and 3D models exposed through consistent HTTP and SDK calling patterns.

FrameLock use:

- temporal segmentation or matting
- video inpainting or video-to-video transformation
- optional video upscaling or audio generation after the core proof works

### 3.2 Serverless

Custom Python or Docker applications with GPU selection, autoscaling, persistent storage, secrets, observability, distributed execution and custom endpoints.

FrameLock conclusion:

- Do not require it for the hackathon MVP.
- Consider it post-hack if FFmpeg/compositing needs a durable media worker.
- Avoid custom model deployment unless Model APIs cannot produce the mask or edit.

### 3.3 Compute

Dedicated SSH-accessible GPU instances including single and multi-H100 configurations.

FrameLock conclusion:

- Not needed for the verified-reshoot thesis.
- Fixed-hourly, manually managed compute adds setup risk without improving the demo.

### 3.4 Platform APIs

REST APIs for:

- model discovery and schemas
- current pricing and estimates
- model usage and analytics
- request records and payload deletion
- Assets, collections, tags and characters
- storage settings, ACLs and signed URLs
- Serverless metrics, logs, files and queues
- Compute instances
- API keys, teams and organization usage
- workflow definitions

The Platform OpenAPI schema contains 55 paths and 74 operations:

- 58 API-key operations
- 15 Admin-key operations
- 1 public metadata operation

The `/models` catalog endpoint is also documented as optionally authenticated, with higher limits when a key is supplied.

---

## 4. Authentication and account setup

### 4.1 Key scopes

fal keys have API and Admin capability boundaries.

FrameLock requires only API-scope operations for:

- model inference
- file upload
- queue status and results
- model discovery/pricing where authenticated access is needed

Admin scope is unnecessary for the MVP and should not be used merely for convenience.

### 4.2 Server-side key requirement

`FAL_KEY` must not ship in browser code. fal's browser setup assumes either:

- a server-side proxy that attaches the key, or
- temporary tokens/token providers for supported client-side realtime cases

FrameLock should use server-owned job routes or a hardened fal proxy.

### 4.3 Next.js proxy security

fal's Next.js proxy is convenient, but its defaults are deliberately backward-compatible rather than safe for a public paid application:

- empty `allowedEndpoints` means every fal endpoint is permitted
- `allowUnauthorizedRequests` defaults to `true`

A public FrameLock proxy must:

- allowlist only selected segmentation and generation endpoints
- set `allowUnauthorizedRequests: false`
- provide an authentication callback
- add rate limits and per-user generation limits
- reject arbitrary target URLs

For the hackathon, dedicated server routes that call exact endpoint IDs may be easier to reason about.

### 4.4 fal CLI distinction

Two packages serve different jobs:

- `fal-client` calls existing Model APIs.
- `fal` builds and deploys custom Serverless applications.

The deployment CLI should not be placed on FrameLock's critical path merely because the brand is the same.

CLI gotchas found in the references:

- `fal run` ignores configured app auth and defaults to public unless `--auth private` is supplied.
- A normal rollout is graceful, while `--force` kills in-flight requests.
- Runtime-tuned scaling may survive deployment unless reset.
- Deleting an environment deletes its apps and secrets.

---

## 5. fal MCP

fal hosts an MCP server at `https://mcp.fal.ai/mcp` using Streamable HTTP and per-request bearer-key authentication.

The documented server exposes nine tools:

Discovery:

- `search_models`
- `get_model_schema`
- `get_pricing`
- `search_docs`

Execution:

- `run_model`
- `submit_job`
- `check_job`

Utility:

- `upload_file`
- `recommend_model`

FrameLock use:

- live catalog discovery during development
- exact schema and pricing checks before hardcoding inputs
- controlled model probes before application integration

The MCP server is described as stateless, uses the caller's key on each request and stores no session. Codex is not given its own setup tab, but the “Other MCP Clients” guidance applies to any client supporting Streamable HTTP.

Documentation inconsistency:

- The MCP overview says `upload_file` accepts a local path or a remote URL.
- The detailed tool reference documents only a `url` parameter.

Verify local-file behavior rather than assuming it.

---

## 6. Inference modes

fal exposes five principal invocation styles.

| Mode | Behavior | Reliability | FrameLock use |
|---|---|---|---|
| `run()` | Direct synchronous HTTP | No durable queue state | Tiny development probes only |
| `subscribe()` | Queue-backed call that blocks while polling | Durable queue underneath | Fast scripts and feasibility tests |
| `submit()` | Returns a durable request ID immediately | Recommended for production | MVP generation and segmentation jobs |
| `stream()` | Progressive output through SSE | Endpoint-specific, no queue durability | Only if a selected model exposes useful intermediate output |
| `realtime()` | Persistent low-latency WebSocket | Endpoint-specific | Not relevant to long video processing |

### 6.1 Queue lifecycle

Queue states:

- `IN_QUEUE`
- `IN_PROGRESS`
- `COMPLETED`

Capabilities:

- persistent request IDs
- queue position
- optional logs
- status streaming
- result retrieval from another process
- cancellation
- webhooks
- automatic retry of qualifying failures

### 6.2 Queue guarantees and limits

The queue documentation states:

- queued requests are not dropped because concurrency is full
- there is no default queue-size limit
- runner failures such as 503, 504 and connection errors can be retried up to ten attempts
- concurrency-related requeues do not have the same fixed maximum while capacity is unavailable
- an explicit start timeout can still expire before work begins

### 6.3 Timeouts

Important distinctions:

- `start_timeout` is time-to-start, covering queue wait, routing and failed attempts before a runner begins.
- It is not a total inference deadline.
- `client_timeout` limits how long a subscribing client waits but does not necessarily stop server work.
- direct Python clients default to a 120-second request timeout.
- streaming chunk timeout defaults to 15 seconds in the JS reference.

FrameLock should show job state rather than guessing that a client timeout means the job ended.

### 6.4 Concurrency

New Model API accounts begin at two concurrent in-progress requests. Limits increase with paid-credit history, with self-service scaling documented up to 40.

Queued requests do not consume concurrency until they enter `IN_PROGRESS`.

FrameLock implication:

- Persist and queue two or three variants safely.
- Do not promise simultaneous execution.
- Build the first golden path sequentially.

### 6.5 Retry-language tension

Some pages say direct `run()` calls have no automatic retry, while another says SDKs retry selected 502/503/504 and concurrency failures.

Safe conclusion:

- Do not rely on implicit direct-call retries.
- Use queue-backed calls for long jobs.
- Treat SDK concurrency retry as different from durable server job retry.

---

## 7. Webhooks

Webhooks can replace polling when an asynchronous request completes.

Documented delivery behavior:

- initial delivery timeout: 15 seconds
- retry count: 10
- retry span: approximately two hours
- repeated deliveries for the same request ID are possible

Security protocol:

1. Fetch fal's Ed25519 JWKS.
2. Read request ID, user ID, timestamp and signature headers.
3. Reject timestamps outside a ±5-minute window.
4. Hash the raw body bytes with SHA-256.
5. Construct the documented newline-delimited message.
6. Verify the signature against a current public key.

Implementation requirements:

- do not verify a reserialized JSON body
- cache JWKS no longer than 24 hours
- key idempotency by `request_id`
- acknowledge quickly and process asynchronously

FrameLock hackathon decision:

- prefer queue status streaming or polling first
- add webhooks only if deployment makes polling impractical

---

## 8. SDK and client-library findings

### 8.1 JavaScript/TypeScript

Documented features:

- direct `run()`
- queue-backed `subscribe()`
- explicit `queue.submit`, `status`, `streamStatus`, `result` and `cancel`
- webhooks, priority, hints and custom headers
- SSE-style `stream()`
- WebSocket realtime connections
- storage upload with recursive File/Blob transformation
- proxy middleware
- retry utilities with exponential backoff and jitter

Gotchas:

- always await the stream's completion or handle its terminal event
- user-requested 504 timeouts are explicitly non-retryable
- temporary realtime token refresh depends on declared expiration
- realtime defaults include 128 ms send throttling and a two-frame recommended buffer

### 8.2 Python

`fal-client` supplies:

- sync and async clients
- request handles
- queue status iteration
- result retrieval and cancellation
- streaming for supported endpoints
- realtime support
- CDN upload helpers

FrameLock decision:

- Next.js/TypeScript owns the product UI and job API.
- A small Python/NumPy/OpenCV worker may own exact media processing because array-level pixel operations and negative tests are easier to express and audit there.
- Avoid adding FastAPI unless a separate process boundary becomes necessary.

### 8.3 Mobile clients

Official or documented clients cover Swift, Kotlin/Java and Dart. Their local pages are quick starts rather than complete references.

Mobile support is out of scope for FrameLock's hackathon build.

---

## 9. Sandbox, Playground, Workflows and Assets

### 9.1 Sandbox

Sandbox can compare multiple models side by side, normalize semantically equivalent inputs, estimate cost and chain results into later operations.

Video operations include:

- text-to-video
- image-to-video
- start/end-frame video
- video upscale
- background removal
- video-to-audio

Useful hackathon role:

- compare mask and generation quality before integration
- inspect cost and duration
- save strong inputs and prompts

Do not build a generic model comparator. fal already has one.

Sandbox and Playground free credits or coupons cannot be spent through Model APIs or Workflows.

### 9.2 Playground

Each endpoint Playground is optimized for one model, exact parameters and code-copying. Use it for schema-specific probes after Sandbox identifies a candidate.

### 9.3 Workflows

Workflows chain model nodes into one endpoint and stream:

- `submit`
- `completion`
- `output`
- `error`

Strengths:

- model-to-model DAGs
- field references between node outputs and inputs
- intermediate progress events
- reusable pipeline endpoint

FrameLock limitation:

- the product includes a human mask-approval pause
- local deterministic normalization, compositing and audit
- immutable artifacts and exact hashes

Application-level orchestration is the better P0 boundary. Workflows may later coordinate the model-only section.

### 9.4 Assets

Assets provides substantially more than file browsing:

- text, image and video semantic search
- filtering by media type and source
- manual, smart and character collections
- tags and favorites
- reusable character references and identifiers

Gotchas:

- `POST /assets/uploads` ingests an already fal-hosted URL, not raw browser bytes
- generated results appear only for request sources enabled in dashboard settings
- semantic image/video search requires fal-hosted media URLs

FrameLock conclusion:

- do not rebuild asset management during the hackathon
- consider Assets post-hack for reusable source plates, masks and verified variants

---

## 10. Platform APIs

### 10.1 Model discovery

`GET /models` supports:

- list mode
- exact endpoint lookup
- free-text/category/status search
- OpenAPI schema expansion
- enterprise-status expansion

Authentication is optional for catalog discovery and increases rate limits when provided.

This corrects an earlier research assumption: a `FAL_KEY` is not required to search the full live catalog or retrieve an endpoint's public OpenAPI schema.

### 10.2 Pricing and estimation

Endpoints:

- current model prices
- estimate planned cost
- usage
- analytics
- request summaries
- raw billing events

Pricing may be based on:

- output second
- image
- megapixel
- request
- GPU/compute unit

The estimate API supports:

- historical call quantity
- expected billing-unit quantity

Authenticated pricing is more authoritative than prose in a model article because account discounts and model prices can change.

FrameLock must query current prices for its exact shortlisted endpoints once a key is available.

### 10.3 Usage and analytics

Available metrics include:

- volume
- errors
- queue latency
- preparation latency
- execution latency
- cold starts
- billable duration

Usage records can include unit quantity, unit price, computed cost and auth identity. Some detailed records require Admin scope.

### 10.4 Request search

The OpenAPI schema contains semantic request search by text, image or video, returning request input/output and similarity. It has no dedicated Markdown operation page.

Possible post-hack use:

- find previous reshoots similar to a new source or prompt
- identify reusable generation results

### 10.5 Schema coverage defects

The Platform schema contains 74 operations while dedicated operation pages cover 72. Missing dedicated pages include:

- semantic request search
- moving an asset collection

The top-level `api-reference/openapi.json` is an unrelated Mintlify plant-store sample. The authoritative Platform schema is under `api-reference/platform-apis/openapi/v1.json`.

---

## 11. Curated model-reference taxonomy

The 138 curated model-reference files declare 250 unique endpoints.

| Area | Files | Endpoints |
|---|---:|---:|
| 3D | 7 | 9 |
| Audio | 6 | 5 |
| Image | 60 | 124 |
| Video | 60 | 104 |
| Vision | 4 | 8 |
| Root index | 1 | 0 |

### 11.1 Video endpoint taxonomy

The 104 documented video endpoints break down as:

- 24 text-to-video
- 30 image-to-video
- 12 reference, element or character-conditioned video
- 10 video-to-video edit, reference or remix
- 5 motion/performance transfer
- 8 avatar, lip-sync or audio-driven endpoints
- 4 preset effects
- 3 video extension endpoints
- 3 explicit first/last-frame endpoints
- 3 video upscalers
- 2 video background-removal/matting endpoints

Seventeen endpoints across families expose an explicit end/last-frame input.

### 11.2 Image endpoint taxonomy

The 124 image endpoints break down as:

- 37 text-to-image, generation or adaptation
- 37 general/reference editing, remix, Redux or image-to-image
- 28 targeted, masked, product or background edits
- 14 segmentation, detection, OCR, depth or preprocessing
- 4 image upscalers
- 4 ControlNet, structural or tiling endpoints

### 11.3 Remaining taxonomy

3D:

- image/text/multi-image to 3D
- part decomposition
- topology optimization

Audio:

- text-to-speech
- voice creation
- video-to-audio
- Whisper transcription/translation

Vision:

- captioning
- OCR
- region interpretation
- NSFW classification
- general VLM routing

---

## 12. FrameLock model shortlist

### 12.1 LTX 2.3 Quality video inpainting — preferred experimental reshoot engine

Endpoint:

`fal-ai/ltx-2.3-quality/inpaint`

Evidence grade: live public schema, active as of July 17, 2026.

Required inputs:

- `prompt`
- `video_url`
- `mask_video_url`

Most important schema contract:

> White mask regions are regenerated. Black mask regions are preserved from the source video.

Other controls:

- FPS: default 24, range 1–60
- frames: default 121, range 9–481
- inference steps: default 15, range 8–30
- guidance scale: default 1, range 1–20
- video strength: default 1, range 0–1
- generated audio: default true, can be disabled
- prompt expansion: default true
- seed
- safety checker
- output quality and write mode

Why it matches FrameLock:

- It consumes the temporal mask directly.
- The protected object can be black while nearly the entire environment is white.
- It may preserve timing and geometry more naturally than an unconstrained full-frame edit.
- FrameLock can still copy and verify the canonical decoded source samples inside the protected core afterward.

Needs a real run:

- quality when most of the frame is white/regenerated
- whether black regions are actually byte-preserved or only structurally preserved
- edge behavior around a moving foreground
- output frame count and timing
- latency
- current price

Initial test configuration:

- canonical 24 FPS source
- exactly 121 frames at 24 FPS, a nominal interval of `121/24` seconds (about 5.0417 seconds)
- `video_strength: 1`
- `num_inference_steps: 15`
- `generate_audio: false`
- `frames_per_second: 24`
- `enable_prompt_expansion: false`, or persist the response's final `prompt` value
- black protected object, white environment

### 12.1A Wan VACE 14B inpainting — Motion v1 primary reshoot engine

Endpoints:

- `fal-ai/wan-vace-14b`
- `fal-ai/wan-vace-14b/inpainting`

Evidence grade: live fal schema and public fal example artifacts, verified July
18, 2026.

The live schema accepts `video_url`, `mask_video_url`, optional
`ref_image_urls` and explicit controls for output frame count, FPS, resolution,
sampling and temporal downsampling. Motion v1 can therefore request all of the
following instead of relying on endpoint defaults:

- `task: "inpainting"`
- `match_input_num_frames: true`
- `match_input_frames_per_second: true`
- `resolution: "720p"`
- `aspect_ratio: "16:9"`
- `num_interpolated_frames: 0`
- `temporal_downsample_factor: 0`
- `enable_auto_downsample: false`
- `preprocess: false`
- `return_frames_zip: true`

The fal page prices 720p output at $0.08 per video second, calculated at 16
frames per second. A 121-frame request therefore represents 7.5625 billed
video seconds, or a public estimate of $0.605 per candidate.

Mask polarity was checked against fal's own documented example pair:

- source: `https://storage.googleapis.com/falserverless/vace/src_video.mp4`
- mask: `https://storage.googleapis.com/falserverless/vace/src_mask.mp4`

The source's gray occlusion rectangle and the mask's matching white rectangle
occupy the same pixels. That example establishes white as the inpaint/edit
domain and black as the retained domain for this endpoint. FrameLock therefore
uses white for the environment and black for the moving character, then still
restores and verifies the character's protected core locally rather than
treating model preservation as proof.

Why Motion v1 prefers it over full-frame editing:

- temporal masks directly express the moving protected subject;
- a selected Nano Banana Pro environment plate can be supplied as a reference;
- input frame count and FPS matching can be requested explicitly;
- downsampling and interpolation can be explicitly disabled;
- local deterministic composition remains the final authority even if the
  model changes the character or boundary.

### 12.2 Kling O3 Standard video edit — high-creativity fallback

Endpoint:

`fal-ai/kling-video/o3/standard/video-to-video/edit`

Documented inputs:

- MP4 or MOV
- duration 3–10 seconds
- resolution 720–2160 pixels
- maximum 200 MB
- up to four combined elements and reference images
- source audio retained by default

Strength:

- natural-language transformation of subject, setting and style
- preservation of rough motion structure
- dramatic creative output

Limitations:

- no mask input
- no documented unchanged-pixel guarantee
- no documented current price in the curated page
- no strict output frame count, FPS or geometry guarantee

FrameLock use:

- send the source for a full generative reshoot
- set `keep_audio: false` and remux source audio locally
- apply a comparability gate before source-mask compositing
- use only if visual alignment survives

### 12.3 Kling O1 edit — documented-price fallback

Endpoint:

`fal-ai/kling-video/o1/video-to-video/edit`

Documented snapshot facts:

- similar 3–10 second input envelope
- 720–2160 dimensions
- 24–60 FPS validation
- up to four combined references
- price in the curated prose: $0.168 per output second

Do not assign O1's price to O3. Query live pricing before budgeting.

### 12.4 BiRefNet v2 video — foreground-mask candidate

Endpoint:

`fal-ai/birefnet/v2/video`

Capabilities:

- foreground/background dichotomous segmentation
- optional explicit `mask_video`
- foreground refinement
- multiple model variants including light, heavy, matting, portrait and dynamic
- operating resolutions 1024, 2048 and dynamic 2304
- H.264, VP9, ProRes 4444 and GIF output options

Strength:

- explicit mask output
- best documented full-foreground mask candidate
- well matched to a hero product isolated as the foreground

Limitation:

- it is not arbitrary-object tracking
- it cannot select one object among several foreground objects
- its temporal stability and edge quality are not established by the schema and require a real run

### 12.5 SAM 3 video — desired click/box tracker

Endpoint:

`fal-ai/sam-3/video`

Evidence grade: live public schema.

Inputs:

- video URL
- text prompt
- point prompts
- box prompts
- detection threshold 0.1–1.0
- apply-mask boolean
- X264 or VP9 output

Declared outputs:

- segmented video
- optional ZIP of per-frame bounding-box overlays

Critical uncertainty:

The live schema does not declare a raw temporal matte or mask archive. A segmented video may permit matte extraction, but that behavior must be observed. Do not make arbitrary click-to-lock a committed feature until one real run yields a compositable mask.

### 12.6 SA2VA video — semantic mask alternative

Endpoint:

`fal-ai/sa2va/8b/video`

Evidence grade: live public schema.

Capabilities:

- prompt-based video interpretation and dense segmentation
- 5–100 sampled frames
- explicit `masks` array in output, described as label-to-mask-video entries

Potential FrameLock role:

- arbitrary semantic object mask when SAM 3's output is not directly usable

Needs a run:

- exact output schema nested inside `masks`
- whether masks cover every canonical frame or only sampled frames
- temporal stability
- price and latency

### 12.7 VOID video inpainting — clean-plate alternative

Endpoint:

`fal-ai/void-video-inpainting`

Evidence grade: live public schema.

Capabilities:

- removes a described object and interactions from video
- can accept a binary or four-level quad mask
- can invoke SAM 3 internally from `mask_prompt`
- frame-window control from 69 to 197 in backend-safe increments
- optional second-pass temporal refinement
- seed and timing output

Mask semantics:

- 0: object to remove
- 63: overlap
- 127: affected region
- 255: background to keep

Potential FrameLock role:

- generate a clean background plate behind a removed product
- then composite the product from the canonical decoded source frames back

Limitation:

- designed for object removal rather than radical whole-environment transformation

### 12.8 Bria video background removal

Endpoint:

`bria/video/background-removal`

Documented constraints:

- input dimensions below 4000×4000
- duration below 30 seconds
- transparent output options and multiple codecs
- output retains audio

Limitation:

- no separate raw mask field in the curated schema
- one published output example incorrectly uses PNG metadata for a video response

### 12.9 Sora 2 remix

Endpoint:

`fal-ai/sora-2/video-to-video/remix`

Unsuitable for FrameLock input because it only accepts a `video_id` from a prior Sora generation, not an arbitrary uploaded source clip.

### 12.10 Grok video edit

Grok's edit path supports arbitrary video but resizes input to at most 854×480 and truncates to eight seconds. Output at 480p/720p is weak for a preservation-oriented product demo.

### 12.11 Frame-by-frame image inpainting

Documented image models include FLUX Fill, Z-Image Inpaint, Bria editing and other mask-based image endpoints.

They are not recommended for the core video path because independent frame generation has no temporal consistency guarantee and risks severe flicker.

---

## 13. Other relevant model capabilities

### 13.1 First/last-frame video

Strong families include:

- Kling O3 image-to-video with optional end frame and 3–15 second output
- Seedance 2 image-to-video with start/end images, 4–15 seconds, 480p/720p and optional native audio
- Veo 3.1 first/last frame with 4, 6 or 8 seconds and 720p/1080p/4K options
- Kling O1 with conflicting schema and prose durations, requiring a live test

Possible post-MVP use:

- generate a background plate that loops back to a known composition
- create controlled campaign transitions

### 13.2 Reference consistency

- Kling O1 Reference supports up to seven combined elements, references and a start frame.
- Kling O3 Reference supports elements, start/end frames and image references with an effective cap of four.
- Seedance 2 Reference supports up to nine images, three videos and three audio clips, with 12 total files.
- xAI Reference supports up to seven images.

These provide semantic identity consistency, not exact logo, text or pixel preservation.

### 13.3 Motion and performance transfer

- DreamActor v2 accepts a drive video up to 30 seconds and supports full-body, face, non-human and multi-character cases.
- Kling 2.6/3 motion control uses reference motion with 10- or 30-second limits depending on orientation mode.

These are useful creative tools but do not solve product invariants.

### 13.4 Audio and lip sync

- Kling video-to-audio accepts 3–20 second MP4/MOV clips up to 100 MB.
- Kling LipSync accepts 2–10 second video and 2–60 second audio and is documented at $0.014 per rounded five-second increment in the snapshot.
- Avatar and OmniHuman families support longer audio-driven performance generation.
- Several Seedance, Kling, Sora, Veo and Grok endpoints generate native audio.

FrameLock decision:

- disable generated audio during the verified visual pipeline
- remux canonical source audio for the MVP
- add generated environment audio only after timing is stable

### 13.5 Upscaling

- SeedVR video supports factors 1–10 or targets through 2160p with temporal consistency.
- Topaz video supports 1–4× scaling, interpolation and enhancement controls.
- Bria video supports 2×/4× resolution increase under documented limits.

Critical ordering:

> Upscale the generated background before restoring protected pixels. A generative upscaler applied after restoration invalidates the exact-core claim.

### 13.6 Depth

The curated reference contains still-image depth endpoints such as ImageUtils depth and Marigold depth. It does not document a video-depth endpoint.

Depth-aware occlusion and relighting are post-hack features.

### 13.7 FFmpeg and compositing

No documented fal endpoint provides general trim, mux, extraction, alignment, overlay or deterministic video compositing.

FrameLock needs local/server-side FFmpeg, WebCodecs or a custom media worker.

---

## 14. Deterministic proof implications

### 14.1 What models cannot guarantee

No reviewed model contract guarantees:

- arbitrary object tracking through every occlusion
- perfect temporal masks
- unchanged product pixels
- exact logos or text
- identical output geometry and timing
- deterministic equality from a seed
- lossless equality after H.264/H.265 encoding

### 14.2 Correct claim

Use:

> FrameLock deterministically restores and verifies the declared protected core after generation.

Do not use:

> Kling or LTX preserved the object perfectly.

### 14.3 Protected core and boundary

One mask cannot honestly serve two conflicting goals without explanation:

- exact canonical source-sample preservation favors a hard binary boundary
- visual integration favors blending and feathering

FrameLock resolves this with:

- an eroded binary protected core with strict zero-delta verification
- a separate boundary ring optimized for appearance
- a generated exterior

### 14.4 Lossy encoding

H.264 and H.265 can change decoded pixels even if the pre-encode composite was exact.

The dossier therefore recommends:

- audit canonical raw or lossless frames
- export a browser-compatible MP4 separately
- optionally re-decode and report a second delivery-file audit
- label the audited stage in every badge and manifest

### 14.5 Hashes and signatures

Hashes provide integrity checks. They do not prove an independent party created or witnessed the media.

If a future product calls the artifact cryptographically “Verified,” it should:

- define a canonical manifest serialization
- sign the manifest with a stable service identity
- publish a verifier
- protect signing keys

For the hackathon, “pixel verification report” is the honest term.

---

## 15. Storage, privacy and retention

### 15.1 fal CDN defaults

Generated media and uploaded inputs are normally returned as public fal CDN URLs unless access controls are applied.

Private source URLs cannot simply be passed through unless the model runner can fetch them. Use:

- fal upload
- a presigned URL
- appropriate CDN ACLs

### 15.2 JSON request retention

Request inputs and outputs are documented as retained for 30 days by default.

`X-Fal-Store-IO: 0` opts out of JSON I/O storage but does not delete media stored on the CDN.

### 15.3 Media lifecycle

`X-Fal-Object-Lifecycle-Preference` can request explicit expiration and initial ACL behavior for generated media.

Documentation tension:

- different pages describe defaults as account-configured, at least seven days or effectively persistent

Safe conclusion:

- set an explicit lifecycle
- download demo artifacts locally immediately
- never depend on undocumented default retention

### 15.4 ACLs

v3 CDN ACLs support:

- allow
- forbid, returning 403
- hide, returning 404
- user-specific overrides

Input uploads and model outputs need separate access treatment.

Signed URLs:

- default validity: 24 hours
- maximum validity: seven days

Gotcha:

- invalid or unknown ACL users may be dropped, so verify the applied response

### 15.5 Hackathon recommendation

- use only new, owned, non-sensitive footage
- set a short explicit lifecycle where practical
- retain local copies of every submission artifact
- inspect generated and source URLs before publishing the repository
- never commit fal-hosted URLs containing private material

---

## 16. Reliability and error handling

### 16.1 Failure classification

Distinguish:

- invalid input or schema errors
- safety/policy rejections
- queue/concurrency delay
- infrastructure failure
- model execution failure
- local media-processing failure
- audit failure
- non-comparable output

Do not map all of them to “generation failed.” The recovery action differs.

### 16.2 Retries

- Let queue-backed infrastructure retry qualifying server failures.
- Do not blindly retry invalid input or policy failures.
- Preserve fal request IDs and error types.
- Add application-level idempotency around local job creation.
- For Platform API mutations that support it, use `Idempotency-Key`; 26 documented mutations accept it.

### 16.3 Model fallback behavior

fal can use model fallbacks by default. This improves availability but may weaken an exact provenance statement.

For a provenance-sensitive demo run:

- record the actual endpoint and returned metadata
- consider `x-app-fal-disable-fallback: true` if the selected endpoint honors it
- do not claim one model created the output unless the request evidence supports that claim

### 16.4 Errors in transition

The documentation indicates error schemas are evolving. Some endpoints return structured `detail[].type`, while others use a more generic form.

FrameLock should:

- validate known shapes
- preserve raw error payload and request ID
- fall back to a generic diagnostic without silently defaulting fields

---

## 17. Pricing and capacity

### 17.1 Billing model

Models may bill per:

- output second
- image or output
- megapixel
- request
- compute time

Queue waiting is not billed. Successful outputs are billed. Some validation failures may still cost money if work already reached the GPU.

### 17.2 Current-price boundary

The public model catalog exposes metadata and schemas without a key, but the pricing endpoint returned an authorization error during this research.

Before implementation, query authenticated current prices for:

- LTX 2.3 Quality inpaint
- SAM 3 video
- SA2VA video
- BiRefNet v2 video
- VOID video inpainting
- Kling O3 Standard and Pro edit
- Kling O1 fallback

Do not use O1's documented $0.168/second snapshot as an O3 estimate.

### 17.3 Cost-control recommendations

- validate source and mask before generation
- ask for user mask confirmation before spending on video
- start with one variant
- persist completed results and reuse them
- expose cancellation while queued
- add endpoint allowlists and request limits
- use the cheapest proven model for repeated development runs
- reserve high-quality generations for hero outputs

---

## 18. Serverless and Compute findings

### 18.1 Serverless capabilities

- managed Python or custom Docker images
- setup/teardown lifecycle
- autoscaling to zero
- rolling deploys and rollback
- environments and revisions
- persistent `/data`
- secrets and KV
- Prometheus metrics, logs and OpenTelemetry
- distributed multi-GPU execution

Billing includes runner setup, idle, execution, draining and termination time. Queue wait and image pull are treated differently according to the pricing pages.

### 18.2 Machine catalog

Documented machine types include:

- A100 40 GB
- L40 48 GB
- H100 80 GB
- RTX Pro 6000 96 GB
- H200 141 GB
- B200 192 GB

H100 lacks hardware video encoding, while L40 and RTX Pro 6000 include it. That distinction could matter for a future hosted video worker.

### 18.3 Compute

Documented configurations include:

- 1× H100 with 16 vCPU, 200 GB RAM, 80 GB VRAM and 1 TB SSD
- 8× H100 with 128 vCPU, 1.6 TB RAM, 640 GB VRAM and 8 TB SSD

Provisioning is described as roughly two to three minutes with fixed hourly billing and manual lifecycle.

FrameLock conclusion:

- neither Serverless nor Compute is required for the hackathon
- a post-hack durable compositor might use Serverless if access and video codecs are proven

---

## 19. Documentation contradictions and defects

These findings affect implementation trust and should remain visible.

1. **Full docs vs full model catalog:** the complete docs index contains only a curated model-reference subset. Live discovery found important absent models.
2. **Public Model Search:** authentication is optional for model discovery, correcting the earlier assumption that a key was mandatory for the full catalog.
3. **SAM 3 output:** marketing describes tracking and segmentation, but the live schema declares a segmented video and bounding-box archive, not a raw matte.
4. **Direct retries:** pages differ until concurrency retries are separated from durable inference retries.
5. **Media retention:** defaults are described inconsistently. Set lifecycle explicitly.
6. **Team permissions:** role descriptions conflict with possession of Admin-key capabilities. Treat actual key scope as the boundary.
7. **GPU catalog:** the Serverless FAQ mentions RTX 4090/5090 while the machine table omits them.
8. **Bria video example:** one output example reports PNG metadata for a video response.
9. **BiRefNet naming:** “General Use Heavy” maps to an internally named lite model in one schema. Use the public enum/label and test quality.
10. **MCP upload:** overview and detailed parameter reference disagree about local-path support.
11. **Proxy defaults:** unrestricted endpoint and unauthenticated defaults are unsafe for a public paid app.
12. **Queue-length parameter:** `fal_max_queue_length` is a query parameter even though one passage suggests headers.
13. **Errors:** error formats are still being migrated and cannot be assumed identical.
14. **O3 gaps:** curated O3 references omit price and strict output-geometry guarantees.
15. **Model fallback:** automatic fallback helps uptime but complicates exact provenance.
16. **Top-level OpenAPI sample:** `api-reference/openapi.json` is an unrelated sample rather than fal's Platform API.
17. **Region examples:** Serverless region names differ between guides and `pyproject` reference.
18. **Old examples:** several examples use older Kling, Luma or MiniMax endpoints and should guide integration shape, not current model selection.

---

## 20. Ideas considered after the documentation review

### 20.1 FrameLock — selected

Why it wins:

- combines fal capabilities with application-owned technical differentiation
- solves a recognizable product/brand problem
- has a visually immediate demo
- allows a real negative test
- maps cleanly to Developer Track technical execution

### 20.2 Continuity Contract — second

Concept:

- creators declare immutable details across generated shots
- system audits outputs and selectively regenerates failures

Why not first:

- requires broader semantic evaluation
- harder to demonstrate an exact guarantee
- larger multi-shot scope within 44.5 hours

### 20.3 Motion Sketch — third

Concept:

- turn a crude phone performance or blocking pass into a cinematic shot while retaining motion

Why not first:

- models already offer motion/performance transfer
- easier to dismiss as an API wrapper
- lacks FrameLock's proof artifact

### 20.4 Ideas explicitly rejected

- Generic model comparator: fal Sandbox already does this.
- Generic workflow editor: fal Workflows already does this.
- Character library: fal Assets already provides characters and references.
- Raw Kling wrapper: insufficient technical differentiation.
- Full continuity fixer: crowded category and broader validation problem.
- Frame-by-frame inpainting: temporal flicker risk.
- Custom GPU model deployment: unnecessary access and setup risk.

---

## 21. Final implementation implications

### Architecture decision

Use:

- Next.js application shell
- server-only fal client
- durable queue request IDs
- canonical local media frames
- one prepared static mask for the first proof
- Kling O3 Standard Edit as the selected synthetic-proof generator after LTX failed comparability
- deterministic compositor
- independent verifier
- separate preview and proof artifacts

### Model decision outcome

The live LTX result failed comparability at 1280 × 768 and 5:3. Kling O3 Standard Edit is the selected synthetic-proof generator after returning 1280 × 720, 121 frames and 24/1 FPS. BiRefNet, SAM 3 and SA2VA remain deferred research candidates.

### Honest product claim

The documentation review supports this exact language:

> FrameLock uses fal to regenerate a controlled source video, then deterministically restores the declared protected core from canonical source frames and verifies the result with per-frame pixel metrics and hashes.

If an automatic fal masking route actually ships, name that endpoint separately in final copy. Do not imply model-based segmentation when the submitted build uses the prepared static-mask path.

It does not support:

> fal guarantees the product never changed.

---

## 22. Primary official sources

Core platform:

- [Documentation home](https://fal.ai/docs/documentation)
- [Complete documentation index](https://fal.ai/docs/llms.txt)
- [Model API overview](https://fal.ai/docs/documentation/model-apis/overview)
- [Model search API](https://fal.ai/docs/platform-apis/v1/models)
- [fal MCP](https://fal.ai/docs/documentation/setting-up/mcp)

Inference and integration:

- [Asynchronous queue](https://fal.ai/docs/documentation/model-apis/inference/queue)
- [Reliability](https://fal.ai/docs/documentation/model-apis/inference/reliability)
- [Concurrency limits](https://fal.ai/docs/documentation/model-apis/concurrency-limits)
- [Webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks)
- [Next.js proxy](https://fal.ai/docs/documentation/model-apis/inference/proxy-setup)
- [Workflows](https://fal.ai/docs/documentation/model-apis/workflows)
- [Sandbox](https://fal.ai/docs/documentation/model-apis/sandbox)

Storage:

- [fal CDN](https://fal.ai/docs/documentation/model-apis/fal-cdn)
- [Data retention](https://fal.ai/docs/documentation/model-apis/media-expiration)
- [File access controls](https://fal.ai/docs/documentation/model-apis/file-access-controls)

Curated FrameLock models:

- [BiRefNet v2 video](https://fal.ai/docs/model-api-reference/video-generation-api/birefnet-v2)
- [Kling O3 Standard video-to-video](https://fal.ai/docs/model-api-reference/video-generation-api/kling-video-o3-standard-video-to-video)
- [Kling O1 video-to-video](https://fal.ai/docs/model-api-reference/video-generation-api/kling-video-o1-video-to-video)
- [Bria video](https://fal.ai/docs/model-api-reference/video-generation-api/bria-video)

Live-catalog supplements:

- [LTX 2.3 Quality inpaint](https://fal.ai/models/fal-ai/ltx-2.3-quality/inpaint/api)
- [SAM 3 video](https://fal.ai/models/fal-ai/sam-3/video/api)
- [SA2VA video](https://fal.ai/models/fal-ai/sa2va/8b/video/api)
- [VOID video inpainting](https://fal.ai/models/fal-ai/void-video-inpainting/api)

---

## 23. Research conclusion

The fal documentation does not merely validate FrameLock; it sharpens the architecture.

The platform already supplies model discovery, durable inference, masking candidates, video inpainting, full-frame video editing, storage and progress primitives. Rebuilding those would waste the hackathon.

FrameLock should invest its limited time in the layer fal does not claim to provide:

- a declared immutable region
- a deterministic restoration boundary
- explicit core versus seam semantics
- a reproducible audit
- a demo where failure is visible and honest

The live evidence selected Kling O3 Standard Edit: the mask-conditioned LTX result was not comparable, while Kling met the frozen timing and geometry contract. Regardless of generator, the final guarantee comes from FrameLock's own compositor and verifier, not the model.
