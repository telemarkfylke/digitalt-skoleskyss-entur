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

## Request Shape Used By The Project

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

## Validation Rules

`validateSkoleskyssRequest` checks:

- Required fields: `studentId`, `applicationId`, `validity`
- Date format: `YYYY-MM-DD`
- Date logic: `endDate >= startDate`
- At least one `zones` entry
- Zone format correctness
- Basic email format (if set)
- Phone number format (if set)

## Useful Commands

PowerShell note:
- Use an extra separator when passing flags: `npm run <script> -- -- <flags>`

- Test Entur authentication:

```bash
npm run test-entur
```

- Dry-run sync:

```bash
npm run sync-entur
```

- PowerShell-friendly aliases (recommended for common runs):

```bash
# Live sync all students
npm run sync-entur-live-all

# Live sync selected students
npm run sync-entur-live-single --student-ids="81722,12345"

# Dry-run sync all students
npm run sync-entur-dry-all

# Dry-run sync selected students
npm run sync-entur-dry-single --student-ids="81722,12345"
```

- Sync one student:

```bash
npm run sync-entur -- -- --method single --student-id "81722"
```

- Sync multiple students:

```bash
npm run sync-entur -- -- --method single --student-ids "81722,12345,77793"
```

- Validate all sync methods:

```bash
npm run sync-entur -- -- --validate
```

- Validate specific students:

```bash
npm run sync-entur -- -- --validate --method single --student-ids "81722,12345"
```

## Notes

- Sync runs with dry-run enabled by default.
- `syncMultipleStudents` reuses the single-student flow and aggregates results.
- Duplicate IDs are de-duplicated before processing.
- `groupOfTariffZoneId` example used in this project:
  - `TEL:GroupOfTariffZones:1`
