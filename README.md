# Golden Lane EMS

Anti-nexus emergency medical routing for India. Single-login, three dashboards, deterministic hospital assignment, tamper-proof audit.

## Run

### Option A: Local Dev Server (No Docker Required)
```bash
python run_local.py
```
- UI: http://localhost:5173 (auto-proxies `/api` & `/ws` to backend)
- API docs: http://localhost:8000/docs

### Option B: Docker Compose (Spec Default)
```bash
cp .env.example .env
docker compose up --build
```
- UI: http://localhost:8080
- API docs: http://localhost:8000/docs

## Demo credentials (password `demo1234` for all)

| Login ID | Role |
|---|---|
| 9820112233 | PATIENT |
| AMB-108 | AMBULANCE_EMT |
| HOSP-01 | HOSPITAL_ED |

## Happy-path test

1. **Patient**: sign in as `9820112233`. Alternatively, click **EMERGENCY SOS (NO LOGIN)** and grant browser geolocation.
2. **Copy** the incident ID from the patient dashboard (or from the SOS JSON).
3. **EMT**: sign in as `AMB-108`, paste the ID, push vitals (SBP=45 → CRITICAL), then run the corridor guard violation test. Patient dashboard updates within 1 s.
4. **Hospital**: sign in as `HOSP-01`, paste the ID, click **Confirm Phase 2 Bed Lock**. Patient dashboard shows `PHASE_2_CONFIRMED`.

## What is real

- bcrypt password verification → HS256 JWT → `require_role` dependency guard on every protected route
- PostGIS SOS: 30 km radius + `icu_beds > 0` filter, `ST_Distance`-derived transit estimate, HospitalScore rank
- Redis `SET NX EX 600` for Phase 1 bed lock; `PERSIST` on Phase 2; TTL-based auto-release
- RTS computation with corrected clinical bands (`<4.0` critical, `<6.0` warning)
- HospitalScore weights normalized to 1.0; route risk applied as a transit multiplier
- SHA-256 chained audit ledger, appended under a `pg_advisory_xact_lock` so the chain never forks; DB trigger rejects UPDATE/DELETE
- 250 m / 120 s corridor check → WebSocket broadcast + SLA accrual
- Article 21 guard: `CRITICAL` band incidents cannot be declined
- CSS variable theme swap (dark EMT vs light clinical) driven by `data-theme`

## Documented stubs (not wired to external systems)

- TRAI DLT transactional SMS — needs Principal Entity registration; template in `services.py` comments
- Audio evidence upload — client ring buffer exists; wire `POST /api/v1/complaints` to S3/MinIO
- PWA service worker offline cache — `manifest.json` present; add Workbox for offline vitals
- Real road-network routing — transit time uses Euclidean distance / 30 km/h effective
- WebSocket auth — accepts any client with an incident ID (acceptable for demo, add JWT query-param check for prod)

## Troubleshooting

- If you changed `db/init.sql`, reset the volume: `docker compose down -v && docker compose up --build`
- If port 8000 or 8080 is taken, edit `docker-compose.yml` ports
- If Postgres container flaps on first boot, wait for both healthchecks to pass (5–10 s)
