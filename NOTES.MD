# Post-vacation TODO — going live checklist

## 1. Server setup

- [ ] Verify `.env` on the server has all required values:
  - DB credentials (`DB_SERVER`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, etc.)
  - Entur credentials (`ENTUR_AUDIENCE`, `ENTUR_CLIENT_ID`, `ENTUR_CLIENT_SECRET`, `ENTUR_TOKEN_URL`, `ENTUR_API_URL`)
  - `TEAMS_WEBHOOK_URL` (for error/failure alerts)
  - `SYNC_QUEUE_FILE=./queue/sync-queue.json`
  - `SYNC_QUEUE_LIMIT=10` (start small — increase gradually after Entur verifies)
  - Fare contract defaults (`ENTUR_AUTHORITY_ID`, `ENTUR_DEFAULT_CALENDAR_ID`, `ENTUR_DEFAULT_TIMEBANDS_START`, `ENTUR_DEFAULT_TIMEBANDS_END`, etc.)
- [ ] Build the compiled output: `npm run build`

---

## 2. Create fareContractRules

- [ ] Edit `src/config/fare-contract-config.ts` — populate `fareContractRules` with real school IDs and class name patterns
- [ ] Rebuild after editing: `npm run build`
- See `docs/ENTUR_INTEGRATION.md` → **Per-school/class overrides** for syntax and matching logic

---

## 3. Build initial queue

- [ ] Run: `npm run sync-entur-queue-rebuild` (dry run — builds queue, does not send to Entur)
- [ ] Open `queue/sync-queue.json` — verify student count and `startDate` ordering look correct
- [ ] Check log output for queue stats (total, pending, sent, failed)

---

## 4. Test with a small batch

- [ ] Run (PowerShell): `$env:SYNC_QUEUE_LIMIT=5; npm run sync-entur-queue-live` (or set `SYNC_QUEUE_LIMIT=5` in `.env` first)
- [ ] Confirm 5 entries moved to `sent` in `queue/sync-queue.json`
- [ ] Confirm Entur received the 5 students (check with Entur team or their portal)

---

## 5. Verify alerting

- [ ] Confirm `TEAMS_WEBHOOK_URL` is set in `.env`
- [ ] Check that a Teams message arrived after the first live batch (or trigger a test failure to confirm the channel)

---

## 6. Windows Task Scheduler — monitor (long-running)

> Do this only after steps 3–5 above are done — the initial queue must already be built and test-verified before the monitor and the hourly drain (step 7) start touching it live.

- [ ] Create a task in Task Scheduler (GUI) with an Action set to:
  ```
  Program/script: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  Add arguments:  -NoProfile -ExecutionPolicy Bypass -Command "node dist/monitor-student-orders.js"
  Start in:       <project root>
  ```
- [ ] Trigger: "At startup" (add "At log on" too if you also want it to fire on interactive logon)
- [ ] On the Settings tab, enable "If the task fails, restart every" (e.g. 1 minute, restart up to a high count) and make sure "Stop the task if it runs longer than" is unchecked/disabled — it must keep running indefinitely
- [ ] On the General tab, run whether user is logged on or not (use a service account / SYSTEM if it shouldn't depend on a user session)
- [ ] Start the task and verify logs show:
  - `Database connected (read-only)`
  - `Queue reconciliation on startup: X new entries added`

---

## 7. Windows Task Scheduler — queue drain (hourly batch)

- [ ] Create a recurring task in Task Scheduler (GUI) with an Action set to:
  ```
  Program/script: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  Add arguments:  -NoProfile -ExecutionPolicy Bypass -Command "node dist/sync-students-to-entur.js --method queue --dry-run false"
  Start in:       <project root>
  ```
- [ ] Trigger: recurring hourly (or at whatever cadence Entur requests) — "Repeat task every: 1 hour" with a duration of "Indefinitely"
- [ ] On the Settings tab, make sure "Stop the task if it runs longer than" is long enough to cover a single run (e.g. 30 min), so a slow run doesn't get killed mid-batch
- [ ] Test the task manually (right-click → Run) before waiting for the first scheduled trigger, and check the History tab / logs for a clean exit
- [ ] `SYNC_QUEUE_LIMIT` in `.env` controls how many students are sent per run (default: 10). Each run picks exactly that many from the front of the queue — it does NOT send everything at once.
- [ ] Gradual rollout plan — increase `SYNC_QUEUE_LIMIT` in `.env` as Entur verifies each batch. No code change needed, just update the value and re-run:
  - Start: `10`
  - After first verification: `50`
  - After second verification: `100`
  - When fully verified: `0` (sends all pending in one run)
- [ ] Note: if a task is set to "run whether user is logged on or not" / SYSTEM, `.env` must be readable without a user session (no per-user env vars)

---

## 8. Gradual rollout

- [ ] After Entur confirms first batch is correct → increase `SYNC_QUEUE_LIMIT` to 50
- [ ] After second confirmation → increase to 100
- [ ] When fully verified → set `SYNC_QUEUE_LIMIT=0` to drain remaining queue
- [ ] Monitor `queue/sync-queue.json` and `logs/` after each increase
