# Carbon Reef

**Every Mangrove Leaves Proof**

An AI-verified blue carbon registry: a community member photographs a mangrove
restoration site, the submission is checked against satellite vegetation data and
a vision model, and a passing claim is minted as an ERC-721 credit on Polygon.

[Live deployment](https://next-gen-xi-plum.vercel.app) ·
[Contract on Polygon Amoy](https://amoy.polygonscan.com/address/0xce1144770a0fA4f002fC23c70b00b45a9e7b94Db)
(`0xce1144770a0fA4f002fC23c70b00b45a9e7b94Db`, chain ID 80002)

> Testnet only. Credits minted here have no monetary value and are not registry-issued
> carbon offsets.

---

## The Problem

India has 4,991 km² of mangroves storing 67 Tg of carbon, yet has sold $0 in blue
carbon credits.

The blocker is verification economics. Third-party verification costs
$75,000–250,000 upfront, while a 100-hectare community project generates only
$12,000–25,000/year in credit revenue. The audit costs more than several years of
the revenue it unlocks, which prices small community projects out of carbon markets
entirely — the projects closest to the ecosystem are the ones that cannot afford to
prove anything.

Carbon Reef tests whether a cheap, repeatable, machine-checked evidence trail can
cover part of that gap: not replacing accredited verification, but making a
low-cost claim of *site vegetation presence* auditable by anyone.

---

## How It Works

### 1. Upload — `POST /api/submit`

The submitter connects a MetaMask wallet and uploads a site photo. The browser
attempts `navigator.geolocation` to fill coordinates automatically and falls back
to manual entry if permission is denied or the lookup times out.

The route validates the photo (JPEG/PNG/WebP, ≤10 MB), the coordinates
(lat −90…90, lng −180…180) and the wallet (`0x` + 40 hex chars), pins the photo to
IPFS through Pinata, and writes a `Submission` row with `status = pending`.

### 2. Verify — `POST /api/verify/[submissionId]`

Two independent signals are collected:

- **Satellite** — a ~50 m bounding box is built around the *submitted* coordinates
  and sent to the Sentinel Hub Statistical API, which computes mean NDVI from
  Sentinel-2 L2A bands B04/B08 over the last 30 days (max 80% cloud cover).
- **Vision** — the photo is pulled back from IPFS, base64-encoded, and sent to
  OpenAI `gpt-4o-mini`, which returns a 0–100 confidence that the image shows
  mangrove or coastal vegetation, plus a short reasoning string.

Both scores and the reasoning are stored in the `Verification` table.

**Why two signals.** Each one alone has a hole the other closes:

| Fraud vector | Caught by |
| --- | --- |
| A genuine mangrove photo submitted against coordinates that are not a mangrove site (photo reused, or claim filed for land the submitter doesn't restore) | Satellite — NDVI at the submitted coordinates will be low |
| Wrong or unrelated photo (a lawn, a stock image, a different biome) submitted at coordinates that genuinely are vegetated | Vision — the model scores the image itself, not the location |

Neither check trusts the other's input: the satellite reads the coordinates and
never sees the photo; the vision model reads the photo and never sees the
coordinates. A claim that passes has agreement between an on-the-ground artefact
and an independent orbital measurement of the same place.

### 3. Mint — `POST /api/mint/[submissionId]`

Once `status = verified`, the server signs a `mintCredit(to, uri)` call with the
contract owner's key and mints an ERC-721 token to the submitter's wallet address,
with the IPFS photo URL as the token URI. The tx hash is written to the database
*before* awaiting confirmation, so a crashed invocation cannot cause a double mint
on retry.

Note: the user's wallet is used as an identifier and mint recipient only — it never
signs a transaction. All on-chain writes come from the server-held deployer key,
which is also the contract's `onlyOwner` minter.

---

## Tech Stack

Versions below are the ones actually installed (`package.json` + lockfile), not
the ranges in the manifest.

| Layer | Choice | Version |
| --- | --- | --- |
| Framework | Next.js (App Router) | 14.2.35 |
| UI | React, Tailwind CSS | 18.3.1, 3.4.19 |
| Language | TypeScript | 5.9.3 |
| ORM | Prisma + `@prisma/client` | 5.22.0 |
| Database | PostgreSQL (Neon; `pg` driver present) | `pg` 8.23.x |
| Storage | IPFS via Pinata (`pinFileToIPFS` REST API) | — |
| Satellite | Sentinel Hub Statistical API, Sentinel-2 L2A NDVI | API v1 |
| Vision | OpenAI Chat Completions, `gpt-4o-mini` | — |
| Chain | Solidity 0.8.20, OpenZeppelin Contracts 5.x, ethers.js | ethers 6.17.0 |
| Tooling | Hardhat + hardhat-toolbox | Hardhat 2.22.x |
| Network | Polygon Amoy testnet | chain ID 80002 |
| Hosting | Vercel | — |

Pinata, Sentinel Hub and OpenAI are called with plain `fetch` — no vendor SDKs are
installed.

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │  Browser (Next.js client)    │
                    │  MetaMask · geolocation      │
                    └───────────────┬──────────────┘
                                    │  fetch()
                    ┌───────────────▼──────────────┐
                    │   Next.js API routes         │
                    │   (Node runtime, Vercel)     │
                    └──┬────────┬────────┬─────┬───┘
                       │        │        │     │
        ┌──────────────▼┐  ┌────▼────┐ ┌─▼───────────┐ ┌────▼──────────┐
        │ PostgreSQL    │  │ Pinata  │ │ Sentinel Hub│ │ OpenAI        │
        │ (Neon,        │  │ IPFS    │ │ Sentinel-2  │ │ gpt-4o-mini   │
        │  via Prisma)  │  │ pinning │ │ NDVI stats  │ │ vision        │
        └───────────────┘  └─────────┘ └─────────────┘ └───────────────┘
                       │
              ┌────────▼─────────┐
              │ Polygon Amoy     │
              │ CarbonCredit.sol │
              │ (ethers v6)      │
              └──────────────────┘
```

### API routes

| Route | Method | Description |
| --- | --- | --- |
| `app/api/submit/route.ts` | `POST` | Accepts multipart form (`photo`, `latitude`, `longitude`, `wallet`). Validates input, upserts the `User` by wallet address, pins the photo to IPFS via Pinata, creates a `Submission` with `status = pending`. Returns `{ id, ipfs_hash, status }` (201). |
| `app/api/submissions/route.ts` | `GET` | `?wallet=0x…` — returns that wallet's submissions newest-first, each with `photo_url`, coordinates, `status`, `verification_status`, and `tx_hash` (joined from `Credit`, `null` if unminted). Unknown wallet returns an empty list, not a 404. |
| `app/api/verify/[submissionId]/route.ts` | `POST` | Runs the satellite NDVI check and the vision check, upserts a `Verification` row, updates `Submission.status` and `Submission.verification_status`. Returns both scores, the model's reasoning, and both status fields. |
| `app/api/mint/[submissionId]/route.ts` | `POST` | Requires `status = verified`. Idempotent — an existing `tx_hash` short-circuits and returns the stored record. Otherwise checks the deployer balance (≥0.001 MATIC), calls `mintCredit`, persists the hash, waits for confirmation, parses `tokenId` out of the `Transfer` log. Returns `{ token_id, tx_hash, explorer_url }`. |

All four routes handle `OPTIONS` and emit CORS headers driven by `FRONTEND_ORIGIN`
(`lib/cors.ts`), and set `maxDuration = 60`.

Verification and minting are **manual, user-triggered actions** from the dashboard —
there is no queue, cron, or automatic pipeline after upload.

### Data model (`prisma/schema.prisma`)

`User` (wallet address) → `Submission` (photo, IPFS hash, coordinates, status) →
one optional `Verification` (NDVI score, photo confidence, reasoning) and one
optional `Credit` (token ID, tx hash).

---

## Security

- Secrets (`PINATA_JWT`, `SENTINELHUB_CLIENT_ID`/`SECRET`, `OPENAI_API_KEY`,
  `ALCHEMY_RPC_URL`, `POSTGRES_URL`, `DIRECT_URL`) are loaded from environment
  variables only — never committed. `.env` is gitignored; only `.env.example` (no
  real values) is tracked.
- All third-party API calls (Pinata, Sentinel Hub, OpenAI, Alchemy RPC) happen
  server-side in API routes — no client-side code ever holds a real credential.
- Wallet addresses are validated with a strict 0x-prefixed 40-hex-character check
  before any database write (see `app/api/submit/route.ts`).
- Mint idempotency: a submission's `tx_hash` is persisted before the mint
  transaction is awaited, preventing double-mints on retry (see
  `app/api/mint/[submissionId]/route.ts`).
- Every submission's IPFS hash is content-addressed (Pinata/IPFS) — the photo
  itself cannot be silently swapped after submission without changing the hash.
- Known gap: no per-workspace secret rotation tooling yet (single-tenant
  deployment, manual rotation via each provider's dashboard). See
  `LIMITATIONS.md`.

---

## Getting Started

### Prerequisites

- Node.js 18+ (the app uses `AbortSignal.timeout`, `fetch`, `FormData`)
- A PostgreSQL database — Neon works; any Postgres with a direct connection URL does
- Accounts/keys for: Pinata, Sentinel Hub (OAuth client credentials), OpenAI
- A Polygon Amoy RPC endpoint (Alchemy) and a funded deployer wallet for minting

### Install and run

```bash
git clone <repo-url>
cd Next-gen-repo

npm install          # postinstall already runs `prisma generate`
npx prisma generate  # re-run manually after schema edits
npx prisma db push   # create the tables in your database

cp .env.example .env # then fill in the values below

npm run dev          # http://localhost:3000
```

Other scripts: `npm run build`, `npm run start`, `npm run lint`, and
`npm run test:db` (`scripts/test-db.ts`, a connectivity check). `scripts/` also
holds one-off Hardhat/diagnostic scripts (`deploy.ts`, `test-sentinel.ts`,
`test-openai.ts`, `test-rpc.ts`, …) used during development.

To deploy the contract yourself:

```bash
npx hardhat run scripts/deploy.ts --network amoy
```

### Environment variables

Every variable the code actually reads. **Placeholders only — never commit real
values;** `.env` is gitignored.

| Variable | Read by | Description |
| --- | --- | --- |
| `POSTGRES_URL` | `prisma/schema.prisma` (`datasource.url`) | Postgres connection string used at runtime (pooled connection on Neon). |
| `DIRECT_URL` | `prisma/schema.prisma` (`directUrl`) | Direct, unpooled Postgres URL used by `prisma migrate` / `db push`. |
| `FRONTEND_ORIGIN` | `lib/cors.ts` | Comma-separated allowlist of origins echoed in CORS headers. `*` allows any origin; an unmatched origin falls back to the first entry. |
| `PINATA_JWT` | `app/api/submit`, `app/api/verify` | Pinata JWT for pinning uploads and for authenticated reads from the Pinata gateway. Required — submit returns 500 without it. |
| `PINATA_GATEWAY_URL` | `app/api/submit` | Base gateway URL used to build `photo_url`. Defaults to `https://gateway.pinata.cloud/ipfs`. |
| `SENTINELHUB_CLIENT_ID` | `app/api/verify` | Sentinel Hub OAuth2 client ID. Missing → the satellite check is skipped and NDVI is `null`. |
| `SENTINELHUB_CLIENT_SECRET` | `app/api/verify` | Sentinel Hub OAuth2 client secret. Same fallback behaviour. |
| `OPENAI_API_KEY` | `app/api/verify` | OpenAI key for the `gpt-4o-mini` vision call. Missing → photo confidence is `null`. |
| `ALCHEMY_RPC_URL` | `app/api/mint`, `hardhat.config.ts` | Polygon Amoy JSON-RPC endpoint. |
| `DEPLOYER_PRIVATE_KEY` | `app/api/mint`, `hardhat.config.ts` | Private key of the contract owner/minter wallet. Server-side secret — it can mint arbitrary credits. |
| `CONTRACT_ADDRESS` | `app/api/mint` | Address of the deployed `CarbonCredit` contract. |

`NODE_ENV` is also read (`lib/prisma.ts`) but is set by the tooling, not by you.

Example `.env` (placeholders):

```env
POSTGRES_URL="postgresql://user:password@host:5432/neondb?sslmode=require"
DIRECT_URL="postgresql://user:password@host:5432/neondb?sslmode=require"
FRONTEND_ORIGIN="http://localhost:3000"
PINATA_JWT=""
PINATA_GATEWAY_URL="https://gateway.pinata.cloud/ipfs"
SENTINELHUB_CLIENT_ID=""
SENTINELHUB_CLIENT_SECRET=""
OPENAI_API_KEY=""
ALCHEMY_RPC_URL="https://polygon-amoy.g.alchemy.com/v2/YOUR_API_KEY"
DEPLOYER_PRIVATE_KEY=""
CONTRACT_ADDRESS=""
```

---

## Verification Logic

Two separate fields are written by `POST /api/verify/[submissionId]`, and they do
**not** always agree. This is deliberate but easy to misread, so it is spelled out
here.

### `Submission.status` — the gate on minting

Enum: `pending` | `verified` | `rejected`.

```
verified   if  photo_confidence > 60  AND  (ndvi_score > 0.3  OR  ndvi_score is null)
rejected   otherwise (including whenever photo_confidence is null)
```

Only `verified` submissions can be minted. Note the null branch: **if the satellite
check could not run at all — missing Sentinel Hub credentials, OAuth failure,
upstream error, no cloud-free imagery in the 30-day window — the submission can
still be marked `verified` on the vision score alone.** The dual-signal guarantee
described above holds only when NDVI is actually available.

### `Submission.verification_status` — the honest report

Reporting field only; it never affects `status` or minting.

| Value | Condition |
| --- | --- |
| `verified` | `photo_confidence > 60` **and** `ndvi_score > 0.3` — both signals present and both passed. |
| `pending_imagery` | Either signal is `null` — the satellite or the vision check never produced a number, so there is no imagery basis for the call. |
| `failed` | Both signals present, but at least one is below threshold (`photo_confidence ≤ 60` or `ndvi_score ≤ 0.3`). |

So a submission showing `status = verified` with `verification_status =
pending_imagery` was passed on one signal, not two. The dashboard and any consumer
of `/api/submissions` should treat that pair as weaker evidence.

Thresholds are hardcoded in the route: NDVI > 0.3, photo confidence > 60/100.
Neither is calibrated against ground-truth data — they are starting values.

---

## Limitations

This is a prototype. What it does and does not establish:

- **It verifies vegetation presence and location consistency — not tonnes of CO₂.**
  Nothing in this system measures or estimates sequestered carbon. There is no
  biomass model, no allometric equation, no baseline, no additionality test. A
  minted token asserts "a photo of vegetation was submitted for coordinates that
  looked vegetated from orbit," and nothing more.
- **~78% of mangrove carbon is belowground**, in root systems and sediment.
  Sentinel-2 NDVI sees canopy greenness only. The dominant carbon pool is invisible
  to the primary signal.
- **No EXIF geotag cross-check.** The photo's own metadata is never read. Nothing
  stops a submitter from taking a valid mangrove photo in one place and typing
  coordinates for another vegetated place — both checks would pass.
- **No spatial deduplication.** Submissions are not checked against each other's
  coordinates. Two users (or one user twice) can file overlapping or identical
  claims for the same hectare and both can mint.
- **Point-in-time check only.** A single 30-day NDVI window at the moment of
  verification. There is no re-check, no ongoing degradation monitoring, and
  nothing revokes or burns a credit if the site is later cleared.
- **NDVI is not mangrove-specific.** Any dense vegetation — a rice paddy, a
  plantation, scrub — clears the 0.3 threshold. Species discrimination rests
  entirely on the vision model's read of one photo.
- **Single-signal fallback.** As described above, an unavailable satellite check
  does not block verification; it only downgrades `verification_status`.
- **Centralised minting.** `mintCredit` is `onlyOwner` and the owner key lives on
  the server. Whoever holds `DEPLOYER_PRIVATE_KEY` can mint credits without any
  submission at all. Nothing is trust-minimised yet except the on-chain record of
  what was minted.
- **No authentication.** Wallet addresses are accepted as form input and never
  verified by signature — anyone can submit on behalf of any address, and the
  verify/mint endpoints take a submission ID with no caller check.
- **Testnet only.** Polygon Amoy. Tokens have no value and no relationship to any
  compliance or voluntary registry.

The India mangrove-area, carbon-stock and verification-cost figures cited above
come from external sources and are not derived from or checked by anything in this
repository.

---

## Roadmap

- **Temporal NDVI comparison** — compare vegetation before and after the
  restoration window rather than reading a single point in time, so the claim is
  about *change*, not just presence.
- **EXIF verification** — read the photo's embedded GPS tag and timestamp and
  cross-check them against the submitted coordinates, closing the "right photo,
  wrong place" gap.
- **Spatial deduplication** — index claims by geography (geohash or PostGIS) and
  reject overlapping polygons.
- **Mangrove-specific segmentation** — replace the generic NDVI threshold with a
  segmentation model trained on mangrove canopy, to separate mangrove from other
  dense vegetation.
- **CCTS offset methodology alignment** — map the evidence trail onto India's
  Carbon Credit Trading Scheme offset methodology requirements, and identify which
  of them this pipeline could satisfy and which will always need accredited
  human verification.

---

## License

`contracts/CarbonCredit.sol` carries an `SPDX-License-Identifier: MIT` header.
There is currently **no repository-level `LICENSE` file** — add one before treating
the rest of the codebase as licensed.

## Contributors

- Chaitanya Pal — <palchaitanya098@gmail.com>
- Suryakesh — <suryakesharwani15@gmail.com>
