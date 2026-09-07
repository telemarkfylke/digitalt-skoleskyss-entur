# Skoleskyss API — observed contract model vs. documented behaviour

**Status:** open question for Entur
**Environment:** `api.staging.entur.io` (staging), Telemark fylkeskommune
**Tested:** 6 September 2026, ~07:33–07:35 UTC
**Contact:** robin.ellingsen@telemarkfylke.no

## Why we are asking

We were told, and recorded in our own integration notes on 5 September 2026, that:

> **Entur deduplicates on `studentId` and always honours the newest order posted.**

We built our synchronisation around that statement. In particular we assume a student ends up with
**one** fare contract, and that if a pupil has more than one order in a batch, the last one posted
silently becomes their contract.

While implementing `DELETE /skoleskyss` we ran two experiments against staging whose results do not
match that statement. We would like to know which behaviour is authoritative before we rely on
either.

---

## Experiment 1 — one student, two different `applicationId`s

Student `999000042`. Two `POST /skoleskyss` calls differing only in `applicationId` and `endDate`,
then two `DELETE /skoleskyss` calls.

| Step | Request | Response |
|---|---|---|
| 1 | `POST` `studentId: 999000042`, `applicationId: 999000042001`, `endDate: 2027-01-15` | `customerAccountId: TEL:CustomerAccount:e105d685-be46-4035-9640-1735d3d5af35`<br>`fareContractId: TEL:FareContract:5DYRBLUU`<br>`pickupCode: HGLPMKJF` |
| 2 | `POST` same `studentId`, `applicationId: 999000042002`, `endDate: 2027-06-15` | **same** `customerAccountId`<br>`fareContractId: TEL:FareContract:I4EKUXJS`<br>**same** `pickupCode: HGLPMKJF` |
| 3 | `DELETE` `studentId: 999000042`, `applicationId: 999000042001` | `fareContractIds: ["TEL:FareContract:5DYRBLUU"]` |
| 4 | `DELETE` `studentId: 999000042`, `applicationId: 999000042002` | `fareContractIds: ["TEL:FareContract:I4EKUXJS"]` |
| 5 | `DELETE` `applicationId: 999000042001` again | `fareContractIds: []` |

**Observation:** the second POST did not replace the first. Both contracts existed simultaneously and
each had to be deleted separately. One customer account, one shared pickup code, **two** fare
contracts.

## Experiment 2 — same `applicationId` posted twice

Student `999000077`.

| Step | Request | Response |
|---|---|---|
| 1 | `POST` `applicationId: 999000077001`, `endDate: 2027-01-15` | `fareContractId: TEL:FareContract:XHDNB9F3` |
| 2 | `POST` **same** `applicationId: 999000077001`, `endDate: 2027-03-15` | `fareContractId: TEL:FareContract:ESSJAFRC` — a **new** id |
| 3 | `POST` `applicationId: 999000077002`, `endDate: 2027-06-15` | `fareContractId: TEL:FareContract:LADB56FS` |
| 4 | `DELETE` `applicationId: 999000077001` | `fareContractIds: ["TEL:FareContract:ESSJAFRC"]` |
| 5 | `DELETE` `applicationId: 999000077002` | `fareContractIds: ["TEL:FareContract:LADB56FS"]` |
| 6 | `DELETE` `applicationId: 999000077001` again | `fareContractIds: []` |

**Observation:** re-posting the *same* `applicationId` produced a new `fareContractId`, and the
subsequent delete returned only the newest (`ESSJAFRC`). `XHDNB9F3` was never returned by any delete,
so the second post appears to have replaced it.

---

## The model these results imply

A fare contract appears to be keyed on the **pair** `(studentId, applicationId)`, not on `studentId`:

- Same pair posted again → replaces the existing contract (last post wins).
- Different `applicationId` for the same student → an **additional, independent** contract.
- `DELETE` removes only the contract for the pair given in the request body.
- One `customerAccountId` per student, shared across their contracts.

This is consistent with "deduplicates and honours the newest order posted" only if "deduplicates" is
scoped to the pair. It is not consistent with a student ending up with a single contract.

---

## Questions for Entur

1. **Is deduplication keyed on `studentId`, or on `(studentId, applicationId)`?** Our notes say the
   former; staging behaves like the latter.
2. **Can a pupil hold several valid fare contracts at once?** Experiment 1 left two contracts on one
   customer account. Were both valid for travel, or does Entur only honour one?
3. **If both are valid, which does a driver's validator or the app present?** Both contracts shared a
   single `pickupCode`, which suggests one recipient — but two contracts.
4. **Does staging match production here?** All testing above was against `api.staging.entur.io`.
5. **Is there a way to list a student's current contracts?** The API we use exposes only POST and
   DELETE. Without a read endpoint we cannot reconcile our state against Entur's, or detect drift
   after an incident.

## Why this matters to us

A pupil may legitimately hold more than one order at a time — our production data shows a student
with two concurrent orders. Under the documented model those collapse to one contract. Under the
observed model that pupil receives two.

Our synchronisation deliberately sends only one order per pupil per run and orders batches
`ORDER BY ToDate ASC` so that, under last-post-wins, the longest-running contract is the one that
survives. If contracts are per-application, that safeguard does not do what we intended and we will
need to revisit it.

---

## Reproducing

Both experiments were run with plain `POST`/`DELETE` calls against `https://api.staging.entur.io/skoleskyss`
using our normal OAuth2 client-credentials token. Request bodies were otherwise identical to our
production payloads (`groupOfTariffZoneId: TEL:GroupOfTariffZones:1`, default calendar, staging mock
student details). The student ids used (`999000042`, `999000077`) are synthetic values chosen well
outside our real id range; all contracts created during testing were deleted afterwards, confirmed by
a final delete returning `fareContractIds: []`.
