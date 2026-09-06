# Digitalt Busskort

Node.js + TypeScript application for syncing student school transport data from SQL Server to Entur Skoleskyss.

## Requirements

- Node.js 24+
- npm
- Access to SQL Server
- Entur API credentials

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure `.env` with required values:

```env
# Database (required)
DB_SERVER=your_sql_server
DB_PORT=1433
DB_DATABASE=your_database
DB_USER=your_user
DB_PASSWORD=your_password
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=true

# Entur (required for sync/monitor)
ENTUR_AUDIENCE=your_audience
ENTUR_CLIENT_ID=your_client_id
ENTUR_CLIENT_SECRET=your_client_secret
ENTUR_TOKEN_URL=https://<token-host>/oauth/token
ENTUR_API_URL=https://api.staging.entur.io/skoleskyss

# Entur deletion (optional)
ENTUR_DELETE_DRY_RUN=true        # default true; "false" arms real deletes
ENTUR_REVOKE_GRACE_MINUTES=15    # default 15; delay before a lost-approval delete

# Fare contract defaults (applied to all students, override per school/class in src/config/fare-contract-config.ts)
ENTUR_AUTHORITY_ID=TEL:Authority:Telemark
ENTUR_DEFAULT_CALENDAR_ID=TEL:FareDayType:SchoolDayDefaultSchool20252026
ENTUR_DEFAULT_TIMEBANDS_START=5
ENTUR_DEFAULT_TIMEBANDS_END=18
ENTUR_VALIDABLE_ELEMENT_ID=
ENTUR_FARE_PRODUCT_ID=
ENTUR_USER_PROFILE_ID=

# Queue mode (used with --method queue)
SYNC_QUEUE_LIMIT=10        # Students per run (0 = send all pending)
SYNC_QUEUE_FILE=./queue/sync-queue.json

# Optional monitor alerting
TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/...

# Optional sync defaults
SYNC_METHOD=all
SYNC_DRY_RUN=true
SYNC_BATCH_SIZE=10
SYNC_LOG_LEVEL=debug
SYNC_CLASSES=1A,1B
SYNC_GRADE_IDS=1,2
SYNC_STUDENT_ID=81722
SYNC_STUDENT_IDS=81722,12345
SYNC_SCHOOL_YEAR=2026        # Calendar year the school year starts in; defaults to the current one
```

## Commands

- Build: `npm run build`
- Run app entry: `npm start`
- Dev entry: `npm run dev`
- Watch TypeScript: `npm run watch`
- Run tests: `npm test`
- Test DB connection: `npm run test-db-connection`
- Test Entur connection: `npm run test-entur`
- Monitor orders: `npm run monitor-orders`

## Sync Usage

PowerShell note:
- In PowerShell, prefer an extra separator to forward flags reliably: `npm run <script> -- -- <flags>`.

Common sync commands:
- Default dry-run sync: `npm run sync-entur`
- Help: `npm run sync-entur -- -- --help`
- Sync all students: `npm run sync-entur -- -- --method all`
- Live sync all (alias): `npm run sync-entur-live-all`
- Live sync single/multiple (alias): `npm run sync-entur-live-single --student-ids="81722,12345"`
- Dry-run all (alias): `npm run sync-entur-dry-all`
- Dry-run single/multiple (alias): `npm run sync-entur-dry-single --student-ids="81722,12345"`

Filtered sync:

```bash
npm run sync-entur -- -- --method filtered --classes "1A,1B" --grade-ids "1,2"
```

Single student sync:

```bash
npm run sync-entur -- -- --method single --student-id "81722"
```

Multiple students sync (single-student flow per ID):

```bash
npm run sync-entur -- -- --method single --student-ids "81722,12345,77793"
```

## School Year Selection

A student's order belongs to a school year when it **overlaps** that year's calendar span,
August 1st to July 31st. An order ending in the autumn term (e.g. 2026-12-19) belongs to the
2026-2027 school year just as much as one ending 2027-06-20.

All commands default to the school year we are currently in. To target another one, pass the
calendar year it *starts* in:

```bash
npm run sync-entur -- -- --method all --school-year 2026   # the 2026-2027 school year
```

Every sync and validation run logs the resolved window, e.g.
`School year 2026-2027 (orders overlapping 2026-08-01 -> 2027-07-31)` — check this line first
when a student is unexpectedly missing.

Note the monitor resolves its window **once, at startup**, and cannot pick up a new school
year while running. It sends a Teams alert and writes to the critical log once the calendar
passes the year it started with; restart it and run `npm run sync-entur-queue-rebuild` when
that happens.

## Queue Mode

Queue mode is designed for incremental rollout: Entur can verify a small batch before the full sync is enabled.

### How it works

Three separate roles keep the queue in sync:

1. **School year start — build the queue once**: run `npm run sync-entur-queue-rebuild` to fetch all current students from the database and write them to `queue/sync-queue.json`, sorted chronologically. Repeat at the start of each new school year.

2. **Ongoing — monitor adds new students**: the monitor process (`npm run monitor-orders`) reconciles the queue against the database on every startup (catching any students added while the monitor was down), then appends new students to the queue in real time as they appear. Only **approved** orders (`PrimaryStatus = 2`) are queued: an order is usually created unapproved and decided seconds later, so queueing it on creation would fill the queue and the per-run limit with orders that may never be approved. The approving update event is what queues it. Updated orders go directly to Entur only once the queue confirms the order was actually sent already — one that's still `pending` is skipped so it isn't sent before the drain's own send, and one that never reached Entur is queued (if approved) or ignored (if not). Removed orders have their Entur fare contract deleted, and a `sent` order that loses approval is revoked in two stages — `endDate` set to today immediately, then deleted if it is still unapproved after `ENTUR_REVOKE_GRACE_MINUTES`. **Deletes are dry run by default**; set `ENTUR_DELETE_DRY_RUN=false` to arm them. See the dispatch decision diagram in `docs/ENTUR_INTEGRATION.md` for the full flow.

3. **Scheduled drain — Task Scheduler sends batches**: each scheduled run picks the next N pending students from the queue (`SYNC_QUEUE_LIMIT`, default 10) and sends them to Entur. Each student is marked `sent` on success, or kept `pending` for retry. After 3 failures the entry is marked `failed`, skipped permanently, and a Teams alert ("Queue entry permanently failed") is sent. An entry whose order is no longer active in the database (rejected or superseded between queueing and the drain) is instead marked `skipped` on the **first** attempt — no retries, no alert — since retrying cannot make it active again; it returns to `pending` automatically if the order is approved again. If a whole drain run fails outright (e.g. Entur/DB unreachable), a separate "Queue drain sync failed" Teams alert is sent as well. The queue file persists between runs — progress is never lost even if the task is interrupted, and reads/writes are safe to run concurrently from the monitor and the scheduled drain job (each write reloads the file first, so the two processes never clobber each other's changes).

### Queue commands

```bash
# Dry-run: inspect what would be sent (builds queue if missing).
# Never modifies queue state — no entry is marked sent or failed.
npm run sync-entur-queue

# Live: send next 10 students to Entur
npm run sync-entur-queue-live

# Rebuild queue from DB (use at start of new school year)
npm run sync-entur-queue-rebuild

# Send all pending students in one run (PowerShell)
$env:SYNC_QUEUE_LIMIT=0; npm run sync-entur-queue-live

# Override limit for one run
npm run sync-entur -- -- --method queue --queue-limit 50 --dry-run false
```

### Windows Task Scheduler setup

Point the task at `npm run sync-entur-queue-live` (or the equivalent `node dist/sync-students-to-entur.js --method queue --dry-run false`). Run between 09:00–15:00 as required. The queue file at `queue/sync-queue.json` tracks all state across runs.

Recommended first-run sequence — build and verify the queue *before* turning on the always-on monitor and the recurring drain task, so nothing gets live-sent before it's been checked:

```bash
# 1. Build the initial queue from the database (dry run — inspect the file)
npm run sync-entur-queue-rebuild

# 2. Send a small batch to Entur and verify with them (PowerShell)
$env:SYNC_QUEUE_LIMIT=5; npm run sync-entur-queue-live

# 3. Once verified, start the monitor so new students are added to the queue automatically
npm run monitor-orders

# 4. Schedule the recurring drain task, then increase SYNC_QUEUE_LIMIT (or set to 0) as Entur verifies each batch
```

### Fare contract config

`calendarId` and `timeBands` are included in every request. Default values come from `.env`. To override for specific schools or classes, add rules to `fareContractRules` in `src/config/fare-contract-config.ts`:

```typescript
export const fareContractRules: FareContractRule[] = [
  // School 101 — any class
  { schoolIds: ['101'], config: { calendarId: 'TEL:FareDayType:SchoolDay101_20252026' } },
  // School 202 — any class, different calendar and time bands
  { schoolIds: ['202'], config: { calendarId: 'TEL:FareDayType:SchoolDay202_20252026', timeBands: { startTime: 6, endTime: 17 } } },
  // VG3 at school 303 specifically (AND logic — both must match)
  { schoolIds: ['303'], classNamePatterns: ['VG3'], config: { calendarId: 'TEL:FareDayType:SchoolDayVG3_303_20252026' } },
  // All VG3 classes not matched above
  { classNamePatterns: ['VG3'], config: { timeBands: { startTime: 6, endTime: 17 } } },
];
```

Each rule is independent. Within a rule, `schoolIds` and `classNamePatterns` use AND logic (both must match if both are set). Rules are evaluated top-to-bottom — first match wins. Rebuild after editing: `npm run build`.

See `docs/ENTUR_INTEGRATION.md` for the full `OrganisationFareContractConfig` type and detailed fare contract documentation.

## Validation Usage

Validation checks StudentService/sync flows in dry-run mode.

- Validate all methods: `npm run sync-entur-validate`
- Validate all methods (direct): `npm run sync-entur -- -- --validate`
- Validate all with explicit method alias: `npm run sync-entur-validate-all`
- Validate single method alias: `npm run sync-entur-validate-single --student-id="81722"`

Detailed validation commands:

```bash
npm run sync-entur -- -- --validate --method single --student-id "81722"
npm run sync-entur -- -- --validate --method single --student-ids "81722,12345"
npm run sync-entur -- -- --validate --method filtered --classes "1A,1B" --grade-ids "1,2"
```

## Restarting the Monitor

The monitor's startup reconciliation catches orders *added* while it was down, but not orders
that *changed* — those edits are absorbed into the fresh baseline and never detected, so Entur
keeps the stale version indefinitely.

The repair is to re-send the affected students after the restart. Entur deduplicates on
`studentId` and honours the newest post, so a re-send simply overwrites with current data and
is always safe.

### 1. Find who changed while it was down

`Orders.UpdatedTime` and `People.UpdatedTime` tell you exactly that. Use the timestamp of the
monitor's last log line before the restart — or just round down generously, since re-sending
an unchanged student costs one request and changes nothing:

```sql
DECLARE @DownSince DATETIME = '2026-09-05T08:00:00';   -- when the monitor stopped
DECLARE @Start DATE = '2026-08-01', @End DATE = '2027-08-01';  -- current school year

SELECT DISTINCT o.StudentId
FROM dbo.Orders o
INNER JOIN dbo.People p ON p.Id = o.StudentId
INNER JOIN dbo.Schools s ON s.Id = o.SchoolId
INNER JOIN dbo.OrderParts op ON o.Id = op.OrderId
WHERE o.ToDate >= @Start AND o.FromDate < @End
  AND s.Type = 1 AND p.Discriminator LIKE 'Student' AND p.IsActive = 1
  AND UsesMassTransit = 1
  AND (o.UpdatedTime >= @DownSince OR p.UpdatedTime >= @DownSince);
```

### 2. Re-send just those students

```bash
npm run sync-entur-live-single --student-ids="81722,12345"
```

A few minutes of downtime usually returns zero or a handful of rows, so this is normally the
whole job.

### Full re-send

`npm run sync-entur-live-all` re-sends every current student in batches of 10. Reach for it
when the downtime window is unknown or long (an unplanned outage, a lost queue file), or as a
periodic safety net to catch drift from any other cause. It is safe for the same reason, just
slower — and students whose orders fail validation will re-alert to Teams each run, which is a
useful signal that they still have no valid contract.

## Monitor Notes

- `npm run monitor-orders` continuously polls SQL and detects new/updated/removed records.
- The monitor writes audit and error logs to `logs/`:
  - `logs/student-order-monitor.audit.log`
  - `logs/student-order-monitor.error.log`
  - `logs/student-order-monitor.critical.log`
- Retries with exponential backoff are applied when Entur requests fail.
- Before a direct send, the request is validated (same checks as `--validate`); an invalid request (e.g. endDate before startDate) is never sent to Entur — it's logged and alerted to Teams separately from an actual send failure. See "Validation on the monitor's direct-send path" in `docs/ENTUR_INTEGRATION.md`.
- Daily summary and critical failure notifications are sent to Teams if `TEAMS_WEBHOOK_URL` is set. The scheduled queue-drain job (`sync-entur-queue-live`) sends its own Teams alerts too — one per permanently-failed student, and one if an entire drain run fails outright. Invalid requests (e.g. a student missing a required phone number) are also alerted to Teams immediately on first validation failure, before any retries are attempted.
- Current monitor query/filtering is defined directly in `src/monitor-student-orders.ts`.

## Additional Notes

- `sync-entur` runs in dry-run mode by default unless `--dry-run false` is provided.
- Alias scripts in `package.json` avoid PowerShell separator issues for common runs.
- `--method single` supports both `--student-id` and `--student-ids`.
- Duplicate IDs in `--student-ids` are de-duplicated before processing.
- When `ENTUR_AUDIENCE` contains `staging`, `studentDetails` payload values are replaced with mock data.

For Entur request format and API behavior, see `docs/ENTUR_INTEGRATION.md`.
