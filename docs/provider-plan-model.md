# Provider, plan, and network model (design)

Status: design only. Nothing here is built yet.

## Goal

Answer questions like:
- Which plans share providers, and how many?
- Within one line of business (LOB), such as Medicaid, which products overlap?
- Which providers are in a plan but not in another?

## What the payer data gives us

Verified against the live directories:

| Resource | Where it comes from | What it gives us |
|---|---|---|
| `PractitionerRole` | every payer | provider ↔ network membership (`extension: network-reference`) |
| `Organization` (type `Network`) | referenced by roles; L.A. Care returns names for these | the network's name, e.g. "OPTUM CARE NETWORK - APPLE CARE SELECT" |
| `InsurancePlan` | Blue Shield, PHC confirmed; L.A. Care returned 23 plans without readable fields | plan name, plan type, owner, and the networks a plan includes |

Two things we learned that shape the model:

1. **A network is not a plan.** A role points at a network. A plan lists the networks it includes. So a provider is in a plan only through a network.
2. **Plan types are payer-specific.** PHC uses `Medicare Advantage` and `Medicaid`. Blue Shield uses `Qualified Health Plan` for group plans, which doesn't say whether it's commercial, Medicare, or Medicaid. LOB has to be mapped per payer, and some plans will be "unknown".

## Layers

Keep source data untouched. Build comparison views on top.

1. **Raw (already stored):** `fhir_resources`, `nppes_records`.
2. **Source-normalized (already stored):** `providers` (one row per source and source ID), `provider_networks`.
3. **Plans and networks (new):**
   - `payer_networks(source, network_id, name, network_type, fetched_at)`. From `Organization` resources.
   - `payer_plans(source, plan_id, name, plan_type_raw, lob, owner, fetched_at)`. From `InsurancePlan`. `lob` is the normalized value; `plan_type_raw` is kept as-is.
   - `plan_networks(source, plan_id, network_id)`. From `InsurancePlan.network`.
   - `lob_map(source, plan_type_raw, lob)`. Per-payer mapping. Plans with no mapping get `lob = 'unknown'`.
4. **Merged provider (new, derived):**
   - `provider_entities(npi PK, name, first_name, last_name, primary_taxonomy, ...)`. One row per NPI. Name and taxonomy come from NPPES when loaded, otherwise from the first payer record.
   - `provider_entity_links(npi, source, source_provider_id)`. Links each `providers` row to its entity. Rows without an NPI stay unlinked and are reported as such.

Source rows are never overwritten by merging. Merging only creates the entity and link rows.

## Membership chain

```
providers (source, source_provider_id, npi)
   └─ provider_networks (source, source_provider_id, network_id)
        └─ plan_networks (source, plan_id, network_id)
             └─ payer_plans (source, plan_id, lob, name)
```

This is a join, so a provider's plan memberships are derived, not stored. Derived membership avoids storing the same fact twice.

## Overlap query (sketch)

```sql
WITH member AS (
  SELECT DISTINCT p.npi, pl.source, pl.plan_id, pl.lob, pl.name
  FROM providers p
  JOIN provider_networks pn
    ON pn.source = p.source AND pn.source_provider_id = p.source_provider_id
  JOIN plan_networks n
    ON n.source = pn.source AND n.network_id = pn.network_id
  JOIN payer_plans pl
    ON pl.source = n.source AND pl.plan_id = n.plan_id
  WHERE p.npi IS NOT NULL
)
SELECT a.name AS plan_a, b.name AS plan_b, a.lob, count(DISTINCT a.npi) AS shared_providers
FROM member a
JOIN member b
  ON a.npi = b.npi AND (a.source, a.plan_id) < (b.source, b.plan_id)
WHERE a.lob = b.lob          -- filter to one LOB; drop this line to compare across LOBs
GROUP BY 1, 2, 3
ORDER BY shared_providers DESC;
```

Use `a.lob = b.lob` for a same-LOB comparison. Drop it for a cross-LOB view.

## Decisions to make

1. **Matching key.** NPI is the only reliable key. Records without an NPI (about 300 in IEHP so far) can't be merged. Name-and-address matching is possible but needs review, so I'd leave it out of the first version.
2. **Views or tables.** Start with SQL views over the layers above. They're always current and cost nothing to store. Materialize `provider_entities` only if the overlap query is too slow on the full data.
3. **Network names.** Fetching each `Organization` adds one request per network. L.A. Care alone has 169 networks. That's cheap, but it has to run after each network pull.
4. **Group plans.** Blue Shield's employer-group plans probably shouldn't be compared with individual plans. Confirm before the first comparison report.
5. **Stale membership.** A provider removed from a network stays linked until a sync removes it. The model needs a `last_seen` on `provider_networks` before overlap results can be trusted.

## What's needed before this works

- Pull `InsurancePlan` and `Organization` (network type) for each payer. Not built yet.
- Add `lob_map` rows for each payer's plan types. Needs review of the actual type values.
- Add `last_seen` to `provider_networks`.
- NPPES loaded, so names and taxonomy come from one authoritative source.
