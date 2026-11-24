# Deploying DYNAMIC ENGINE to Render

This app deploys to Render as a single Node web service plus a managed PostgreSQL database.

## One-click / Blueprint deploy

1. Push this repository to GitHub or GitLab.
2. In Render, choose **New → Blueprint** and select the repository. Render reads `render.yaml` and provisions:
   - a Node web service (`dynamic-engine`)
   - a PostgreSQL database (`dynamic-engine-db`) with `DATABASE_URL` injected automatically.
3. Click **Apply**. The build command runs `npm ci && npx drizzle-kit push && npm run build`, which installs dependencies, creates/updates all tables, and produces the production bundle.
4. Health check: `GET /api/health` → `{ "ok": true }`.

## Manual deploy

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci && npx drizzle-kit push && npm run build` |
| Start command | `npm run start` |
| Health check path | `/api/health` |
| Node version | `22.11.0` |

### Environment variables

| Key | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Injected by Render from the database. Used by Drizzle. |
| `SESSION_SECRET` | recommended | Key material for AES-256-GCM encryption of the stored Upstox token. If unset, a deterministic server-side fallback derived from `DATABASE_URL` is used. |
| `UPSTOX_BASE_URL` | no | Defaults to `https://api.upstox.com`. |
| `UPSTOX_MAX_RPS` | no | Local rate limiter ceiling (default `6`). |
| `UPSTOX_TIMEOUT_MS` | no | Per-request timeout (default `15000`). |
| `ANALYSIS_TTL_MS` | no | Server cache lifetime for a computed snapshot (default `8000`). Must stay **below** the client scan interval so every scan receives fresh data. |
| `NEXT_PUBLIC_POLL_MS` | no | Client auto-scan interval in ms (default `30000` = 30 seconds). |
| `SESSION_TTL_MS` | no | Lifetime of the encrypted session row (default `43200000` = 12 h). |
| `OI_SNAPSHOT_INTERVAL_MS` | no | Minimum interval between OI/premium snapshot writes per contract (default `30000`). |

## Setting `SESSION_SECRET`

Generate one and add it in the Render dashboard (**Environment → Add environment variable**):

```bash
openssl rand -base64 48
```

Setting it means the stored token remains decryptable across redeploys. Without it, a token
stored before a redeploy cannot be decrypted and the user must reconnect — no plaintext is
ever exposed either way.

## Process model

`numInstances: 1` is set intentionally. The Upstox token lives in per-process runtime memory
for speed and is mirrored in an AES-256-GCM encrypted PostgreSQL row, so a restart or redeploy
re-hydrates the same session rather than reporting "no token". If you later scale beyond one
instance, every instance shares that encrypted store, so the session still resolves — but keep
`numInstances: 1` unless you need horizontal scale, because instrument-master caching and
snapshot throttling are per-process.

## Data refresh behaviour

- The browser **auto-scans both NIFTY and SENSEX every 30 seconds**.
- A **SCAN** button sits at the top-left of the header for an immediate manual scan; it
  restarts the 30-second countdown afterwards so the two never overlap.
- Auto-scan can be paused/resumed from the header (`AUTO 30s` / `AUTO OFF`) or from the mobile menu.
- Changing the timeframe or reconnecting the Upstox token triggers an immediate scan.

## Mobile / touch support

- Fully responsive: the header collapses, the navigation becomes a two-column drawer behind a
  ☰ button, and dense metric grids reflow from 6 columns to 2.
- Every wide table (Option Chain, Diagnostics, Data Foundation, S/R) scrolls horizontally with
  one-finger touch and a right-edge fade affordance.
- Vertical page swiping works everywhere, including over the price chart: the chart pans
  horizontally on drag and zooms by pinch, while vertical drag passes through to the page.
- Tap targets are at least 40 px on touch devices, and `env(safe-area-inset-bottom)` is
  respected on notched phones.

## Post-deploy checklist

1. `GET /api/health` returns `{"ok":true}`.
2. Open the app → **Settings** → paste an Upstox access token → **Connect**. The header must show
   **UPSTOX CONNECTED** (only confirmed after `GET /v2/user/profile` validates the token).
3. **Diagnostics → Run diagnostics** and confirm the NIFTY and SENSEX matrices.
4. Wait ~5–15 minutes with the app open so OI/premium snapshots accumulate, then confirm
   5-minute and 15-minute rolling values appear on the OI Intelligence and Strike Momentum tabs.
