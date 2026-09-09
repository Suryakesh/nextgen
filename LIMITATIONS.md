# Limitations

Exactly what this system does and does not do.

- **Verifies vegetation presence and location consistency at submitted
  coordinates — does not measure tonnes of CO₂ sequestered.** There is no biomass
  model, no allometric equation, no baseline, no additionality test anywhere in
  this pipeline. A minted token asserts "a photo of vegetation was submitted for
  coordinates that looked vegetated from orbit," and nothing more.

- **~78% of mangrove carbon is stored belowground** (root and soil organic carbon)
  and is invisible to both satellite NDVI and photo analysis — this system only
  evidences the above-ground signal. The dominant carbon pool in a mangrove is not
  measured here at all.

- **No EXIF geotag cross-check yet.** The latitude/longitude on a submission is
  user-typed form input, not extracted from the photo's own metadata and
  cross-validated against it. Nothing stops a valid mangrove photo taken at one
  location from being submitted with coordinates for a different vegetated
  location — both verification checks would pass.

- **No spatial deduplication.** The same physical site could be submitted multiple
  times — by the same user or different users — without an automatic duplicate
  check. Overlapping or identical claims are not detected or blocked.

- **Testnet only (Polygon Amoy).** Not deployed to mainnet. No real-world financial
  value is attached to any minted token.

- **On-demand verification, not continuous monitoring.** Each check reflects
  satellite and photo data at the moment of submission — a single point in time.
  There is no ongoing observation window, no re-check, and nothing that revokes or
  flags a credit if the site is degraded or cleared afterward.

- **Additionality is not assessed.** Whether this restoration would have happened
  anyway, without any incentive tied to it, is not something this system evaluates.
  That's a known unsolved problem across the broader carbon-verification field, not
  a gap specific to Carbon Reef.
