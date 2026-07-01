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
  };
  calendarId?: string;          // from OrganisationFareContractConfig
  timeBands?: {                 // from OrganisationFareContractConfig
    startTime: number;
    endTime: number;
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

`calendarId` and `timeBands` are populated automatically from [fare contract config](#fare-contract-config) and omitted from the payload when not set.

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
| Updated student order | Direct Entur call (immediate) |
| Removed student order | Audit log only (cancel endpoint not yet implemented) NOTE: A change will be triggered and a post to entur will happen with the changes |

### Entry dedup rules (`addEntry`)

- `pending` or `sent` → skip (no duplicate)
- `failed` → reset to `pending`, clear error, re-queue
- Not found → add as new `pending` entry

---

## Validation Rules

`validateSkoleskyssRequest` checks:

- Required fields: `studentId`, `applicationId`, `validity`
- Date format: `YYYY-MM-DD`
- Date logic: `endDate >= startDate`
- At least one `zones` entry
- Zone format correctness
- Basic email format (if set)
- Phone number format (if set)

`calendarId` and `timeBands` are not validated — they are optional and Entur handles absent values gracefully.

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
