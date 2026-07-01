# Digitalt Busskort

Node.js + TypeScript application for syncing student school transport data from SQL Server to Entur Skoleskyss.

## Requirements

- Node.js 18+
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

## Queue Mode

Queue mode is designed for incremental rollout: Entur can verify a small batch before the full sync is enabled.

### How it works

Three separate roles keep the queue in sync:

1. **School year start — build the queue once**: run `npm run sync-entur-queue-rebuild` to fetch all current students from the database and write them to `queue/sync-queue.json`, sorted chronologically. Repeat at the start of each new school year.

2. **Ongoing — monitor adds new students**: the monitor process (`npm run monitor-orders`) reconciles the queue against the database on every startup (catching any students added while the monitor was down), then appends new students to the queue in real time as they appear. Updates and removals still go directly to Entur.

3. **Scheduled drain — Task Scheduler sends batches**: each scheduled run picks the next N pending students from the queue (`SYNC_QUEUE_LIMIT`, default 10) and sends them to Entur. Each student is marked `sent` on success, or kept `pending` for retry. After 3 failures the entry is marked `failed` and skipped permanently. The queue file persists between runs — progress is never lost even if the task is interrupted.

### Queue commands

```bash
# Dry-run: inspect what would be sent (builds queue if missing)
npm run sync-entur-queue

# Live: send next 10 students to Entur
npm run sync-entur-queue-live

# Rebuild queue from DB (use at start of new school year)
npm run sync-entur-queue-rebuild

# Send all pending students in one run
SYNC_QUEUE_LIMIT=0 npm run sync-entur-queue-live

# Override limit for one run
npm run sync-entur -- -- --method queue --queue-limit 50 --dry-run false
```

### Windows Task Scheduler setup

Point the task at `npm run sync-entur-queue-live` (or the equivalent `node dist/sync-students-to-entur.js --method queue --dry-run false`). Run between 09:00–15:00 as required. The queue file at `queue/sync-queue.json` tracks all state across runs.

Recommended first-run sequence:

```bash
# 1. Build the initial queue from the database (dry run — inspect the file)
npm run sync-entur-queue-rebuild

# 2. Start the monitor so new students are added to the queue automatically
npm run monitor-orders

# 3. Send a small batch to Entur and verify with them
SYNC_QUEUE_LIMIT=5 npm run sync-entur-queue-live

# 4. Once verified, increase the limit or set to 0 to drain the queue
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

See `docs/ENTUR_INTEGRATION.md` for the full type and detailed matching rules.

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

## Monitor Notes

- `npm run monitor-orders` continuously polls SQL and detects new/updated/removed records.
- The monitor writes audit and error logs to `logs/`:
  - `logs/student-order-monitor.audit.log`
  - `logs/student-order-monitor.error.log`
  - `logs/student-order-monitor.critical.log`
- Retries with exponential backoff are applied when Entur requests fail.
- Daily summary and critical failure notifications are sent to Teams if `TEAMS_WEBHOOK_URL` is set.
- Current monitor query/filtering is defined directly in `src/monitor-student-orders.ts`.

## Additional Notes

- `sync-entur` runs in dry-run mode by default unless `--dry-run false` is provided.
- Alias scripts in `package.json` avoid PowerShell separator issues for common runs.
- `--method single` supports both `--student-id` and `--student-ids`.
- Duplicate IDs in `--student-ids` are de-duplicated before processing.
- When `ENTUR_AUDIENCE` contains `staging`, `studentDetails` payload values are replaced with mock data.

For Entur request format and API behavior, see `docs/ENTUR_INTEGRATION.md`.
