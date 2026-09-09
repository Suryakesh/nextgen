# Architecture

Carbon Reef is verification infrastructure for mangrove restoration claims — not a
carbon-credit issuer and not a trading platform. It checks that photographic evidence
of restoration is consistent with independent satellite data at the claimed
coordinates, and records that verification immutably. Nothing downstream of that
record (crediting, funding, accounting) happens inside this system.

---

## Pipeline

```
Community/NGO photo submission (geotagged)
         │
         ▼
IPFS pinning (Pinata) ── tamper-evident storage
         │
         ▼
┌────────────────────┴────────────────────┐
│                                           │
Sentinel-2 NDVI check                GPT-4o Vision check
(Sentinel Hub API, live               (OpenAI, vegetation
satellite data at submitted           presence classification
coordinates)                          of the actual photo)
│                                           │
└────────────────────┬────────────────────┘
                      ▼
        Both signals must independently agree
                      │
              ┌───────┴───────┐
              ▼               ▼
         verified          rejected
              │
              ▼
    ERC-721 mint on Polygon Amoy
    (evidence trail: ipfs_hash, ndvi_score,
     photo_confidence, tx_hash — all queryable)
```

Each stage maps directly to one API route: `POST /api/submit` runs the first two
boxes, `POST /api/verify/[submissionId]` runs both checks and the agreement gate,
`POST /api/mint/[submissionId]` runs the last box. Every stage is a distinct,
separately-triggered HTTP call — there is no single "process a submission"
background job that walks a submission through all three (see *On-demand, not
continuous* below).

---

## Design principle: evidence-first verification

**The two verification signals — satellite NDVI and vision analysis — are computed
independently and must both agree before a submission is marked `verified`. No
single signal, and no LLM judgment call alone, can approve a submission.**

This is a hard invariant of the system, not a tunable default:

- The satellite check reads only the submitted coordinates. It never sees the
  photo.
- The vision check reads only the photo. It never sees the coordinates.
- Neither check can see the other's output before producing its own score.
- A submission is `verified` only when `photo_confidence > 60` **and**
  `ndvi_score > 0.3` are both true for the same submission.

The reason for the split: a single signal has an exploitable blind spot. A genuine
mangrove photo can be replayed against coordinates that aren't a mangrove site — the
satellite check catches that, because NDVI at those coordinates will be low
regardless of what photo was submitted. An unrelated photo can be submitted against
coordinates that genuinely are vegetated — the vision check catches that, because it
scores the image content directly and doesn't trust the coordinates. Requiring
agreement between an on-the-ground artifact and an independent orbital measurement
of the same place is the actual security property; either check running alone
would not have it.

One documented exception to be aware of, not a second invariant: if the satellite
check cannot run at all (missing Sentinel Hub credentials, an OAuth failure, no
cloud-free imagery in the lookback window), the route's `status` field can still
resolve to `verified` on the vision score alone — the separate `verification_status`
field is what honestly reports this as `pending_imagery` rather than a true
dual-signal pass. See `README.md` → *Verification Logic* for the exact branch.

---

## What Carbon Reef is NOT

- **Not a carbon-credit issuer.** Minting an ERC-721 token here does not create a
  tradeable carbon credit, does not register anything with any carbon standard, and
  does not represent tonnes of CO₂.
- **Not a trading marketplace.** There is no buy/sell/transfer flow, no pricing, no
  matching of credits to buyers.
- **Not a source of legal or financial carbon accounting.** The system verifies
  restoration evidence and records it on-chain. What an organization does with that
  record afterward — a funding application, internal reporting, an application to an
  accredited carbon-credit body — happens entirely outside this system and is out of
  scope for it.

---

## Current deployment

- **Testnet only.** Deployed to Polygon Amoy (chain ID 80002), not mainnet. Minted
  tokens carry no monetary value.
- **Contract:** `CarbonCredit` at
  [`0xce1144770a0fA4f002fC23c70b00b45a9e7b94Db`](https://amoy.polygonscan.com/address/0xce1144770a0fA4f002fC23c70b00b45a9e7b94Db).
- **Live minted proof:** Token ID #2 — minted for a submission that passed both
  verification signals (`verification_status: verified`, not the single-signal
  fallback), tx
  [`0xb5023f1a8aa19c8692b0f655948ca26c7dfb788d31734857001bc2220a11c621`](https://amoy.polygonscan.com/tx/0xb5023f1a8aa19c8692b0f655948ca26c7dfb788d31734857001bc2220a11c621).
- **On-demand, not continuous.** Verification and minting are triggered by a human
  (an NGO/submitter clicking "Verify" or "Mint" on the dashboard), each a separate
  `POST` call. There is no cron job, queue, or background monitoring loop that
  revisits a submission's site after the fact.
