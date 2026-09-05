# Entur Skoleskyss Integration

This project integrates with Entur Skoleskyss using OAuth2 client credentials and a typed service layer.

## Required Environment Variables

```env
ENTUR_AUDIENCE=your_audience
ENTUR_CLIENT_ID=your_client_id
ENTUR_CLIENT_SECRET=your_client_secret
ENTUR_TOKEN_URL=https://<token-host>/oauth/token
ENTUR_API_URL=https://api.staging.entur.io/skoleskyss
```

The integration fails fast on startup if any of these are missing.

## Implemented Services

### `EnturAuthClient` (`src/services/entur-auth.service.ts`)

- Gets OAuth2 token with `client_credentials`
- Caches token until shortly before expiry
- Sends authenticated HTTP requests
- Exposes:
  - `testConnection()`
  - `getTokenInfo()`
  - `refreshToken()`

### `EnturApiService` (`src/services/entur-skoleskyss.service.ts`)

Implemented methods:

- `createSkoleskyss(request)`
- `createBatchSkoleskyss(requests)`
- `createSkoleskyssRequest(data)`
- `validateSkoleskyssRequest(request)`
- `testConnection()`
- `getTokenInfo()`
- `refreshToken()`

Not implemented in current code:

- `updateSkoleskyss(...)`
- `cancelSkoleskyss(...)`

## Request Shape

```typescript
interface PostSkoleskyssRequest {
  organisationId?: number;
  studentId: string | number;
  applicationId: string | number;
  validity: {
    startDate: string; // YYYY-MM-DD
    endDate: string;   // YYYY-MM-DD
    zones: Array<
      | { fromZoneId: string; toZoneId: string }
      | { groupOfTariffZoneId: string }
    >;
    calendar?: { id: string };   // from OrganisationFareContractConfig
    travelWindow?: {             // from OrganisationFareContractConfig.timeBands
      fromHour: number;
      toHour: number;
    };
  };
  studentDetails?: {
    firstName?: string;
    surname?: string;
    school?: {
      id: string | number;
      name: string;
    };
    class?: {
      id: string | number;
      name: string;
    };
    email?: string;
    phone?: {
      number: string;
      countryCode?: string;
    };
  };
}
```

`validity.calendar.id` and `validity.travelWindow` are populated automatically from [fare contract config](#fare-contract-config) and omitted from the payload when not set.

## Fare Contract Config

**File:** `src/config/fare-contract-config.ts`

The full `OrganisationFareContractConfig` type (from Entur):

```typescript
type OrganisationFareContractConfig = {
  authorityId: string;
  name: string;
  timeBands?: { startTime: number; endTime: number };
  validableElementId: string;
  fareProductId: string;
  userProfileId: string;
  maximumNumberOfInterchanges?: number;
  calendarId: string;
  activationMeans: string[];
};
```

### Default config (from `.env`)

All default values are driven by environment variables so the system can be deployed for different counties without code changes:

| Env var | Purpose |
|---|---|
| `ENTUR_AUTHORITY_ID` | Authority identifier |
| `ENTUR_DEFAULT_CALENDAR_ID` | Default calendar (e.g. `TEL:FareDayType:SchoolDayDefaultSchool20252026`) |
| `ENTUR_DEFAULT_TIMEBANDS_START` | Default time band start hour (e.g. `5`) |
| `ENTUR_DEFAULT_TIMEBANDS_END` | Default time band end hour (e.g. `18`) |
| `ENTUR_VALIDABLE_ELEMENT_ID` | Validable element ID |
| `ENTUR_FARE_PRODUCT_ID` | Fare product ID |
| `ENTUR_USER_PROFILE_ID` | User profile ID |

`timeBands` is only included in the request when both start and end env vars are set.

### Per-school/class overrides

Edit `fareContractRules` in `src/config/fare-contract-config.ts` to override the default config for specific schools or classes. You can add as many independent rules as needed.

**Matching logic:**

- Rules are evaluated **top-to-bottom** — the **first matching rule wins**. Place more specific rules before more general ones.
- Within a rule, `schoolIds` and `classNamePatterns` use **AND logic**: if both are set, the student's school *and* class must both match.
- A rule with only `schoolIds` matches any class at those schools. A rule with only `classNamePatterns` matches that class pattern at any school.
- Students that match no rule receive the default config from `.env`.

```typescript
export const fareContractRules: FareContractRule[] = [
  // School 101 — all classes get a specific calendar
  {
    schoolIds: ['101'],
    config: { calendarId: 'TEL:FareDayType:SchoolDay101_20252026' },
  },

  // School 202 — all classes get a different calendar AND different time bands
  {
    schoolIds: ['202'],
    config: {
      calendarId: 'TEL:FareDayType:SchoolDay202_20252026',
      timeBands: { startTime: 6, endTime: 17 },
    },
  },

  // VG3 classes at school 303 specifically — AND logic (both must match)
  // This rule is more specific than a school-only or class-only rule, so put it first
  {
    schoolIds: ['303'],
    classNamePatterns: ['VG3'],
    config: { calendarId: 'TEL:FareDayType:SchoolDayVG3_303_20252026' },
  },

  // All VG3 classes at any school not already matched above
  {
    classNamePatterns: ['--TIP1'],
    config: { timeBands: { startTime: 6, endTime: 17 } },
  },
];
```

Each rule is fully independent — changing one rule has no effect on the others. A student is evaluated against each rule in order and assigned the first match's config merged on top of the default.

After editing rules, rebuild the project: `npm run build`.

## Queue Architecture

The sync queue decouples student detection from Entur API calls, allowing controlled rollout at any pace.

### Three roles

| Role | Process | Trigger |
|---|---|---|
| **Build** | `npm run sync-entur-queue-rebuild` | Once per school year (or on demand) |
| **Append** | `npm run monitor-orders` (long-running) | Continuous — new students detected in DB |
| **Drain** | `npm run sync-entur-queue-live` | Windows Task Scheduler (e.g. 09:00–15:00) |

### Dispatch decision (new / updated / removed)

```mermaid
flowchart TD
    A[Monitor detects a change] --> B{Change type}

    B -->|new| N1["queueService.addEntry()<br/>queued as 'pending'"]
    N1 --> N2[Scheduled drain: sync-entur-queue-live]
    N2 --> N3{validateSkoleskyssRequest}
    N3 -->|invalid| N4[Stays pending/failed<br/>retried next scheduled run]
    N3 -->|valid| N5[createSkoleskyss]
    N5 -->|success| N6[markSent]
    N5 -->|failure| N7["markFailed — retry up to 3x,<br/>then permanently 'failed' + Teams alert"]

    B -->|updated| U1["queueService.getEntry(ordersId)"]
    U1 --> U2{Queue entry status?}
    U2 -->|pending| U3[Skip direct send —<br/>drain will use fresh DB data]
    U2 -->|failed| U4["Re-queue via addEntry()<br/>reset to pending, retryCount 0"]
    U2 -->|sent or no entry| U5[processEnturChange:<br/>validate, then send directly]
    U5 --> U6{validateSkoleskyssRequest}
    U6 -->|invalid| U7["Throw EnturValidationError<br/>critical log + Teams: 'Entur Request<br/>Validation Failed (Not Sent)'"]
    U6 -->|valid| U8["createSkoleskyss with retry —<br/>on exhaustion: critical log + Teams:<br/>'Critical Entur Sync Failure'"]

    B -->|removed| R1[Audit log only —<br/>cancel endpoint not implemented]
```

An `updated` change only reaches Entur directly once the queue confirms it's safe to: if the
order's queue entry (added when it was first seen as `new`) is still `pending`, it hasn't actually
been created in Entur yet, so a direct send here would race — or duplicate — the scheduled drain's
own send, and the update is skipped in favor of letting the drain pick up fresh DB data. If the
entry is `failed`, it's re-queued instead of sent directly, so it gets a full retry cycle on the
next drain. Only when the entry is `sent` (or, as an edge case, no entry exists at all — e.g. the
queue file was reset independently of the monitor) does the direct send proceed. This logic lives
in `QueueService.getEntry()` (`src/services/queue.service.ts`) and `decideUpdateDispatchAction`
(`src/utils/queue-dispatch-decision.utils.ts`).

### Queue file

Both the monitor and the scheduler share `queue/sync-queue.json` (path configurable via `SYNC_QUEUE_FILE`).

Each entry tracks: `studentId`, `ordersId`, `startDate`, `status`, `retryCount`, `addedAt`, `processedAt`.

**Status lifecycle:**
```
pending → sent        (scheduler processed successfully)
pending → pending     (scheduler failed, retryCount < maxRetries — retried next run)
pending → failed      (scheduler failed, retryCount >= maxRetries — permanently skipped)
failed  → pending     (monitor re-queues via addEntry if the student reappears in DB)
```

### Downtime recovery

`CustomQueryMonitor` establishes a silent baseline on first poll — records present in the DB at startup are not emitted as `NEW_RECORDS`. This means students added while the monitor was down would normally be missed.

The monitor handles this with a **startup reconciliation**: before `startMonitoring()` begins, it runs the same SQL query once via `getCurrentResults()` and calls `addEntry()` for every DB record not already in the queue as `pending` or `sent`. The reconciliation log shows how many entries were added vs. already present.

### What goes through the queue vs. direct

| Change type | Handling |
|---|---|
| New student order | Added to queue → sent by scheduler in next batch |
| Updated student order | Direct Entur call (immediate) — unless the order's queue entry is still `pending`/`failed` (see the dispatch decision diagram above) |
| Removed student order | Audit log only — cancel endpoint not yet implemented, no Entur call is made |

### Entry dedup rules (`addEntry`)

- `pending` or `sent` → skip (no duplicate)
- `failed` → reset to `pending`, clear error, re-queue
- Not found → add as new `pending` entry

---

## How Entur handles duplicate posts

**Entur deduplicates on `studentId` and always honours the newest order posted.** Confirmed
with Entur, 5 Sep 2026.

This matters, because the queue and dispatch-decision logic above is built around *avoiding*
duplicate sends and can read as though a duplicate were dangerous. It is not:

- **Re-sending is safe.** Sending a student's order again overwrites their existing contract
  with the same data. Where recovery is needed — a lost queue file, drift after monitor
  downtime, an uncertain partial run — a full re-send (`npm run sync-entur-live-all`) is a
  legitimate repair, not a risk. The queue's dedup rules exist to avoid pointless API traffic
  and racing the scheduler, not to prevent corruption.
- **But send order carries meaning.** Last post wins per student, so if more than one order
  for the same student is posted in a single run, the last one silently becomes their
  contract. Two consequences are built into the code:
  - `syncFromQueue` sends only the order its queue entry refers to, never the student's other
    orders (`selectQueuedOrder` in `src/utils/queued-order-selection.utils.ts`).
  - The student queries sort `ORDER BY o.ToDate ASC`, so where a student does have more than
    one order in one batch, the longest-running contract is posted last and wins.

---

## Validation Rules

`validateSkoleskyssRequest` checks:

- Required fields: `studentId`, `applicationId`, `validity`, `studentDetails.phone.number`
- Date format: `YYYY-MM-DD`
- Date logic: `endDate >= startDate`
- At least one `zones` entry
- Zone format correctness
- Basic email format (if set)
- Phone number is required: `studentDetails.phone.number` must be present (Entur/skoleskyss requires being able to reach the student/guardian); format: digits only, no spaces/hyphens/country code embedded in `number`; when `countryCode` is `+47` or omitted, `number` must be exactly 8 digits starting with `4` or `9`; `countryCode` itself must be an optional `+` followed by 1-3 digits

`validity.calendar` and `validity.travelWindow` are not validated — they are optional and Entur handles absent values gracefully.

### Validation on the monitor's direct-send path

`validateSkoleskyssRequest` isn't only used by `--validate`/`sync-manager.ts` — the monitor's
direct-send path (`processEnturChange` in `src/monitor-student-orders.ts`) calls it too, right
before `createSkoleskyss` and outside the retry loop (retrying a validation failure would just fail
identically every time). If validation fails, the request is never sent — instead an
`EnturValidationError` is thrown, logged as a critical-log event `entur_validation_failed_skipped`,
and alerted to Teams under the title `"Entur Request Validation Failed (Not Sent)"`, distinct from
the `entur_process_failed_after_retries` / `"Critical Entur Sync Failure"` alert used when
`createSkoleskyss` itself fails after retries are exhausted.

This exists because `mapStudentRecordToEnturRequest`'s `overrideEndDateWhenPrimaryStatusNot2`
option (`src/utils/entur-request-mapper.utils.ts`, used by the monitor for every direct-send
mapping) forces `endDate` to today's date whenever `PrimaryStatus != 2`. If the order's `StartDate`
is still in the future, this produces `endDate < startDate` — an invalid request that would
otherwise reach Entur's API directly and cause an internal server error there.

## Useful Commands

PowerShell note: use an extra separator when passing flags: `npm run <script> -- -- <flags>`

```bash
# Test Entur authentication
npm run test-entur

# Dry-run sync (default)
npm run sync-entur

# Queue mode — send next 10 students (dry run)
npm run sync-entur-queue

# Queue mode — send next 10 students (live)
npm run sync-entur-queue-live

# Rebuild queue from DB (dry run, useful at start of school year)
npm run sync-entur-queue-rebuild

# PowerShell-friendly aliases
npm run sync-entur-live-all
npm run sync-entur-dry-all

# Sync a specific student
npm run sync-entur -- -- --method single --student-id "81722"

# Sync multiple students
npm run sync-entur -- -- --method single --student-ids "81722,12345,77793"

# Validate all sync methods
npm run sync-entur -- -- --validate

# Run tests
npm test
```

## Notes

- Sync runs with dry-run enabled by default.
- `groupOfTariffZoneId` used in this project: `TEL:GroupOfTariffZones:1`
- `syncMultipleStudents` reuses the single-student flow and aggregates results.
- Duplicate IDs are de-duplicated before processing.
- In staging (`ENTUR_AUDIENCE` contains `"staging"`), student details are replaced with Harry Potter 🧙 mock data.
