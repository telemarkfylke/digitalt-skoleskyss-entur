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
