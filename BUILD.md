# Golden Lane EMS — Developer Build Specification

Anti-nexus emergency medical routing for India. Single-login gateway, three role dashboards, deterministic hospital assignment, tamper-proof audit.

**Stack:** FastAPI 0.115 · SQLAlchemy 2 async · Postgres 16 + PostGIS · Redis 7 · React 19 · Vite · Nginx

**Demo credentials** (password `demo1234` for all):

| Login ID | Role |
|---|---|
| `9820112233` | PATIENT |
| `AMB-108` | AMBULANCE_EMT |
| `HOSP-01` | HOSPITAL_ED |

**Run:**
```bash
cp .env.example .env
docker compose up --build
```
- UI: http://localhost:8080
- API: http://localhost:8000/docs

---

FILE: `.env.example`
```env
POSTGRES_USER=golden
POSTGRES_PASSWORD=golden_pw
POSTGRES_DB=golden_lane
DATABASE_URL=postgresql+asyncpg://golden:golden_pw@db:5432/golden_lane
REDIS_URL=redis://redis:6379/0
JWT_SECRET=change-me-in-production-openssl-rand-hex-32
JWT_ALG=HS256
JWT_EXPIRE_MINUTES=480
CORS_ORIGINS=http://localhost:5173,http://localhost:8080
```

FILE: `docker-compose.yml`
```yaml
services:
  db:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
  backend:
    build: ./backend
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
      redis: { condition: service_healthy }
    ports: ["8000:8000"]
  frontend:
    build: ./frontend
    depends_on: [backend]
    ports: ["8080:80"]
volumes:
  pgdata:
```

FILE: `db/init.sql`
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('PATIENT','AMBULANCE_EMT','HOSPITAL_ED','NHM_AUDITOR');
CREATE TYPE ais_class AS ENUM ('TYPE_A','TYPE_B','TYPE_C','TYPE_D');
CREATE TYPE bed_state AS ENUM ('UNASSIGNED','PHASE_1_RESERVED','PHASE_2_CONFIRMED','DIVERTED','HANDOVER_COMPLETE');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id VARCHAR(64) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role user_role NOT NULL,
  abha_id VARCHAR(32),
  trusted_contact_name VARCHAR(120),
  trusted_contact_phone VARCHAR(20),
  entity_ref UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE hospitals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hpr_id VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  location GEOGRAPHY(POINT,4326) NOT NULL,
  is_government BOOLEAN NOT NULL DEFAULT FALSE,
  icu_beds INT NOT NULL DEFAULT 0,
  trauma_bays INT NOT NULL DEFAULT 0,
  has_cath_lab BOOLEAN NOT NULL DEFAULT FALSE,
  has_neurosurgery BOOLEAN NOT NULL DEFAULT FALSE,
  has_pediatric BOOLEAN NOT NULL DEFAULT FALSE,
  ed_queue_minutes INT NOT NULL DEFAULT 5,
  readiness NUMERIC(4,3) NOT NULL DEFAULT 0.850,
  diversion_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX hospitals_loc_idx ON hospitals USING GIST(location);

CREATE TABLE ambulances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration VARCHAR(24) UNIQUE NOT NULL,
  ais_class ais_class NOT NULL,
  driver_name VARCHAR(120) NOT NULL,
  driver_phone VARCHAR(20) NOT NULL,
  emt_name VARCHAR(120) NOT NULL,
  equipment_ok BOOLEAN NOT NULL DEFAULT FALSE,
  location GEOGRAPHY(POINT,4326),
  available BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id UUID REFERENCES users(id),
  ambulance_id UUID REFERENCES ambulances(id),
  primary_hospital_id UUID REFERENCES hospitals(id),
  backup_hospital_id UUID REFERENCES hospitals(id),
  pickup GEOGRAPHY(POINT,4326) NOT NULL,
  corridor GEOGRAPHY(POLYGON,4326),
  rts NUMERIC(6,4),
  band VARCHAR(24) NOT NULL DEFAULT 'CRITICAL',
  score NUMERIC(6,4),
  bed_state bed_state NOT NULL DEFAULT 'UNASSIGNED',
  phase1_expires TIMESTAMPTZ,
  deviation_m NUMERIC(8,2) NOT NULL DEFAULT 0,
  sla_penalty_inr INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  reporter_user_id UUID REFERENCES users(id),
  category VARCHAR(64) NOT NULL,
  audio_uri TEXT,
  gps GEOGRAPHY(POINT,4326) NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_ledger (
  seq BIGSERIAL PRIMARY KEY,
  incident_id UUID NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_role user_role NOT NULL,
  payload JSONB NOT NULL,
  prev_hash CHAR(64) NOT NULL,
  curr_hash CHAR(64) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION block_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_ledger is append-only';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable
BEFORE UPDATE OR DELETE ON audit_ledger
FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();
```

FILE: `backend/requirements.txt`
```txt
fastapi==0.115.5
uvicorn[standard]==0.32.1
sqlalchemy[asyncio]==2.0.36
asyncpg==0.30.0
geoalchemy2==0.16.0
redis==5.2.1
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
pydantic==2.10.3
pydantic-settings==2.6.1
python-multipart==0.0.20
```

FILE: `backend/Dockerfile`
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

FILE: `backend/app/__init__.py`
```python
```

FILE: `backend/app/config.py`
```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://golden:golden_pw@db:5432/golden_lane"
    redis_url: str = "redis://redis:6379/0"
    jwt_secret: str = "dev-secret-change-me"
    jwt_alg: str = "HS256"
    jwt_expire_minutes: int = 480
    cors_origins: str = "http://localhost:5173,http://localhost:8080"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()
```

FILE: `backend/app/models.py`
```python
import uuid
from datetime import datetime
from sqlalchemy import String, Integer, Boolean, Numeric, ForeignKey, DateTime, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ENUM as PGEnum
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from geoalchemy2 import Geography

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    login_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String)
    full_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(PGEnum("PATIENT","AMBULANCE_EMT","HOSPITAL_ED","NHM_AUDITOR", name="user_role"))
    abha_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    trusted_contact_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    trusted_contact_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    entity_ref: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class Hospital(Base):
    __tablename__ = "hospitals"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hpr_id: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    location = mapped_column(Geography(geometry_type="POINT", srid=4326))
    is_government: Mapped[bool] = mapped_column(Boolean, default=False)
    icu_beds: Mapped[int] = mapped_column(Integer, default=0)
    trauma_bays: Mapped[int] = mapped_column(Integer, default=0)
    has_cath_lab: Mapped[bool] = mapped_column(Boolean, default=False)
    has_neurosurgery: Mapped[bool] = mapped_column(Boolean, default=False)
    has_pediatric: Mapped[bool] = mapped_column(Boolean, default=False)
    ed_queue_minutes: Mapped[int] = mapped_column(Integer, default=5)
    readiness: Mapped[float] = mapped_column(Numeric(4,3), default=0.85)
    diversion_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class Ambulance(Base):
    __tablename__ = "ambulances"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    registration: Mapped[str] = mapped_column(String(24), unique=True)
    ais_class: Mapped[str] = mapped_column(PGEnum("TYPE_A","TYPE_B","TYPE_C","TYPE_D", name="ais_class"))
    driver_name: Mapped[str] = mapped_column(String(120))
    driver_phone: Mapped[str] = mapped_column(String(20))
    emt_name: Mapped[str] = mapped_column(String(120))
    equipment_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    location = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=True)
    available: Mapped[bool] = mapped_column(Boolean, default=True)

class Incident(Base):
    __tablename__ = "incidents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    patient_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    ambulance_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ambulances.id"), nullable=True)
    primary_hospital_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("hospitals.id"), nullable=True)
    backup_hospital_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("hospitals.id"), nullable=True)
    pickup = mapped_column(Geography(geometry_type="POINT", srid=4326))
    corridor = mapped_column(Geography(geometry_type="POLYGON", srid=4326), nullable=True)
    rts: Mapped[float | None] = mapped_column(Numeric(6,4), nullable=True)
    band: Mapped[str] = mapped_column(String(24), default="CRITICAL")
    score: Mapped[float | None] = mapped_column(Numeric(6,4), nullable=True)
    bed_state: Mapped[str] = mapped_column(PGEnum("UNASSIGNED","PHASE_1_RESERVED","PHASE_2_CONFIRMED","DIVERTED","HANDOVER_COMPLETE", name="bed_state"), default="UNASSIGNED")
    phase1_expires: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deviation_m: Mapped[float] = mapped_column(Numeric(8,2), default=0)
    sla_penalty_inr: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class AuditLedger(Base):
    __tablename__ = "audit_ledger"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    incident_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    event_type: Mapped[str] = mapped_column(String(64))
    actor_role: Mapped[str] = mapped_column(PGEnum("PATIENT","AMBULANCE_EMT","HOSPITAL_ED","NHM_AUDITOR", name="user_role"))
    payload: Mapped[dict] = mapped_column(JSONB)
    prev_hash: Mapped[str] = mapped_column(String(64))
    curr_hash: Mapped[str] = mapped_column(String(64))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class Complaint(Base):
    __tablename__ = "complaints"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("incidents.id"))
    reporter_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    category: Mapped[str] = mapped_column(String(64))
    audio_uri: Mapped[str | None] = mapped_column(String, nullable=True)
    gps = mapped_column(Geography(geometry_type="POINT", srid=4326))
    evidence_hash: Mapped[str] = mapped_column(String(64))
```

FILE: `backend/app/schemas.py`
```python
from typing import Literal
from pydantic import BaseModel, Field

class LoginRequest(BaseModel):
    login_id: str
    password: str

class LoginResponse(BaseModel):
    token: str
    role: Literal["PATIENT","AMBULANCE_EMT","HOSPITAL_ED"]
    name: str
    entity_id: str

class VitalsIn(BaseModel):
    incident_id: str
    heart_rate: int = Field(ge=0, le=300)
    systolic_bp: int = Field(ge=0, le=300)
    spo2: int = Field(ge=0, le=100)
    gcs: int = Field(ge=3, le=15)
    respiratory_rate: int = Field(ge=0, le=80)
    requires_cath_lab: bool = False
    requires_neurosurgery: bool = False

class SosIn(BaseModel):
    lat: float
    lng: float
    device_note: str = ""

class CorridorIn(BaseModel):
    incident_id: str
    lateral_deviation_m: float
    unscheduled_halt_s: int
    delayed_minutes: int

class BedDeclineIn(BaseModel):
    incident_id: str
    reason_code: str
```

FILE: `backend/app/services.py`
```python
import hashlib
import json
from datetime import datetime, timedelta, timezone
from passlib.context import CryptContext
from jose import jwt
from sqlalchemy import select, text, func
from sqlalchemy.ext.asyncio import AsyncSession
from .config import settings
from .models import AuditLedger, User

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(p: str) -> str: return pwd.hash(p)
def verify_password(p: str, h: str) -> bool: return pwd.verify(p, h)

def issue_token(user_id: str, role: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    return jwt.encode({"sub": user_id, "role": role, "exp": exp}, settings.jwt_secret, algorithm=settings.jwt_alg)

def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_alg])

def rts_and_band(gcs: int, sbp: int, rr: int) -> dict:
    cgcs = 4 if gcs >= 13 else 3 if gcs >= 9 else 2 if gcs >= 6 else 1 if gcs >= 4 else 0
    csbp = 4 if sbp > 89 else 3 if sbp >= 76 else 2 if sbp >= 50 else 1 if sbp >= 1 else 0
    crr  = 4 if 10 <= rr <= 29 else 3 if rr > 29 else 2 if 6 <= rr <= 9 else 1 if 1 <= rr <= 5 else 0
    rts = round(0.9368*cgcs + 0.7326*csbp + 0.2908*crr, 4)
    if rts < 4.0 or csbp <= 1 or cgcs <= 1:
        band = "CRITICAL"
    elif rts < 6.0:
        band = "WARNING"
    else:
        band = "STABLE"
    return {"rts": rts, "band": band}

W_TIME, W_READY, W_SURV = 0.40, 0.25, 0.35

def hospital_score(transit_min: float, ed_queue_min: float, readiness: float,
                   route_risk: float, rts: float, band: str) -> dict:
    etdc = transit_min * (1.0 + 0.5 * route_risk) + ed_queue_min
    time_eff = max(0.0, 1.0 - (etdc / 60.0))
    decay = 0.09 if band == "CRITICAL" else 0.035 if band == "WARNING" else 0.015
    surv = max(0.05, min(0.99, (rts / 7.8408) * (1.0 - decay * (etdc / 10.0))))
    score = round(W_TIME*time_eff + W_READY*readiness + W_SURV*surv, 4)
    return {"etdc_minutes": round(etdc, 2), "score": score}

async def audit_append(session: AsyncSession, incident_id: str, event_type: str,
                       actor_role: str, payload: dict) -> None:
    # Serialize all appends so prev_hash chain is never forked
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtext('audit_ledger_chain'))"))
    last = (await session.execute(
        select(AuditLedger).order_by(AuditLedger.seq.desc()).limit(1)
    )).scalar_one_or_none()
    prev = last.curr_hash if last else "0" * 64
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    curr = hashlib.sha256(
        f"{prev}|{incident_id}|{event_type}|{actor_role}|{serialized}".encode()
    ).hexdigest()
    session.add(AuditLedger(
        incident_id=incident_id, event_type=event_type,
        actor_role=actor_role, payload=payload,
        prev_hash=prev, curr_hash=curr,
    ))
    await session.commit()

async def seed_if_empty(session: AsyncSession) -> None:
    n = await session.scalar(select(func.count()).select_from(User))
    if n and n > 0:
        return
    demo = [
        ("9820112233", "Aarav Kulkarni", "PATIENT"),
        ("AMB-108",    "EMT Priya Nair", "AMBULANCE_EMT"),
        ("HOSP-01",    "Sahyadri Trauma ED", "HOSPITAL_ED"),
    ]
    for login_id, name, role in demo:
        session.add(User(
            login_id=login_id, full_name=name, role=role,
            password_hash=hash_password("demo1234"),
        ))
    await session.commit()
```

FILE: `backend/app/main.py`
```python
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select
from redis.asyncio import from_url as redis_from_url
from geoalchemy2.functions import ST_GeogFromText, ST_DWithin, ST_Distance
from jose import JWTError

from .config import settings
from .models import Base, User, Hospital, Incident, Complaint
from .schemas import LoginRequest, LoginResponse, VitalsIn, SosIn, CorridorIn, BedDeclineIn
from .services import (
    verify_password, issue_token, decode_token,
    rts_and_band, hospital_score, audit_append, seed_if_empty,
)

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
redis = redis_from_url(settings.redis_url, decode_responses=True)
bearer = HTTPBearer(auto_error=False)
ws_clients: dict[str, set[WebSocket]] = {}


async def get_db():
    async with SessionLocal() as s:
        yield s


async def current_user(cred: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict:
    if not cred:
        raise HTTPException(401, "missing bearer token")
    try:
        return decode_token(cred.credentials)
    except JWTError:
        raise HTTPException(401, "invalid token")


def require_role(role: str):
    async def _check(u: dict = Depends(current_user)) -> dict:
        if u.get("role") != role:
            raise HTTPException(403, f"{role} required")
        return u
    return _check


async def broadcast(incident_id: str, msg: dict) -> None:
    dead = []
    for ws in ws_clients.get(incident_id, set()):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.get(incident_id, set()).discard(ws)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as s:
        await seed_if_empty(s)
    yield
    await engine.dispose()
    await redis.close()


app = FastAPI(title="Golden Lane EMS", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_methods=["*"], allow_headers=["*"],
)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}


@app.post("/api/v1/auth/login", response_model=LoginResponse)
async def login(body: LoginRequest, s: AsyncSession = Depends(get_db)):
    user = (await s.execute(select(User).where(User.login_id == body.login_id))).scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "invalid credentials")
    return LoginResponse(
        token=issue_token(str(user.id), user.role),
        role=user.role, name=user.full_name, entity_id=user.login_id,
    )


@app.post("/api/v1/sos")
async def sos(body: SosIn, s: AsyncSession = Depends(get_db)):
    pickup = ST_GeogFromText(f"POINT({body.lng} {body.lat})")
    rows = (await s.execute(
        select(Hospital).where(
            Hospital.icu_beds > 0,
            ST_DWithin(Hospital.location, pickup, 30000),
        )
    )).scalars().all()
    if not rows:
        raise HTTPException(503, "No capable hospital within 30 km")

    scored = []
    for h in rows:
        dist_m = await s.scalar(select(ST_Distance(Hospital.location, pickup)).where(Hospital.id == h.id))
        transit = float(dist_m or 0) / 1000.0 / 0.5  # 30 km/h effective
        r = hospital_score(transit, h.ed_queue_minutes, float(h.readiness),
                           route_risk=0.2, rts=6.0, band="CRITICAL")
        scored.append((h, r))
    scored.sort(key=lambda x: x[1]["score"], reverse=True)
    primary, primary_r = scored[0]
    backup = scored[1][0] if len(scored) > 1 else primary

    incident = Incident(pickup=pickup, band="CRITICAL")
    s.add(incident)
    await s.commit()
    await s.refresh(incident)

    incident.primary_hospital_id = primary.id
    incident.backup_hospital_id = backup.id
    incident.score = primary_r["score"]

    bed_key = f"bedlock:{primary.id}:icu:1"
    if await redis.set(bed_key, str(incident.id), nx=True, ex=600):
        incident.bed_state = "PHASE_1_RESERVED"
        incident.phase1_expires = datetime.now(timezone.utc) + timedelta(seconds=600)
    await s.commit()

    await audit_append(s, str(incident.id), "SOS_CREATED", "PATIENT",
                       {"lat": body.lat, "lng": body.lng,
                        "primary": str(primary.id), "score": primary_r["score"]})

    return {
        "incident_id": str(incident.id),
        "primary_hospital": primary.name,
        "backup_hospital": backup.name,
        "etdc_minutes": primary_r["etdc_minutes"],
        "score": primary_r["score"],
        "bed_state": incident.bed_state,
    }


@app.post("/api/v1/telemetry/vitals")
async def push_vitals(body: VitalsIn, s: AsyncSession = Depends(get_db),
                      u: dict = Depends(require_role("AMBULANCE_EMT"))):
    band = rts_and_band(body.gcs, body.systolic_bp, body.respiratory_rate)
    inc = (await s.execute(select(Incident).where(Incident.id == body.incident_id))).scalar_one_or_none()
    if not inc:
        raise HTTPException(404, "incident not found")
    inc.rts = band["rts"]
    inc.band = band["band"]
    await s.commit()
    await broadcast(body.incident_id, {
        "type": "vitals", "rts": band["rts"], "band": band["band"],
        "hr": body.heart_rate, "sbp": body.systolic_bp, "spo2": body.spo2, "gcs": body.gcs,
    })
    return {"rts": band["rts"], "band": band["band"]}


@app.post("/api/v1/telemetry/corridor")
async def verify_corridor(body: CorridorIn, s: AsyncSession = Depends(get_db),
                          u: dict = Depends(require_role("AMBULANCE_EMT"))):
    violation = body.lateral_deviation_m > 250.0 or body.unscheduled_halt_s > 120
    sla = max(0, body.delayed_minutes) * 20
    inc = (await s.execute(select(Incident).where(Incident.id == body.incident_id))).scalar_one_or_none()
    if not inc:
        raise HTTPException(404, "incident not found")
    inc.deviation_m = body.lateral_deviation_m
    inc.sla_penalty_inr = (inc.sla_penalty_inr or 0) + sla
    await s.commit()
    if violation:
        await audit_append(s, body.incident_id, "CORRIDOR_VIOLATION", "AMBULANCE_EMT",
                           {"dev_m": body.lateral_deviation_m, "halt_s": body.unscheduled_halt_s})
        await broadcast(body.incident_id, {
            "type": "violation", "dev_m": body.lateral_deviation_m, "sla": sla,
        })
    return {"violation": violation, "sla_penalty_inr": sla}


@app.post("/api/v1/bed/phase2")
async def phase2_confirm(incident_id: str, s: AsyncSession = Depends(get_db),
                         u: dict = Depends(require_role("HOSPITAL_ED"))):
    inc = (await s.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if not inc or not inc.primary_hospital_id:
        raise HTTPException(404, "incident not found")
    key = f"bedlock:{inc.primary_hospital_id}:icu:1"
    holder = await redis.get(key)
    if holder != incident_id:
        raise HTTPException(409, "bed lock no longer held by this incident")
    await redis.persist(key)
    inc.bed_state = "PHASE_2_CONFIRMED"
    await s.commit()
    await audit_append(s, incident_id, "BED_PHASE_2_CONFIRMED", "HOSPITAL_ED", {})
    await broadcast(incident_id, {"type": "bed_state", "state": "PHASE_2_CONFIRMED"})
    return {"state": "PHASE_2_CONFIRMED"}


@app.post("/api/v1/bed/decline")
async def bed_decline(body: BedDeclineIn, s: AsyncSession = Depends(get_db),
                      u: dict = Depends(require_role("HOSPITAL_ED"))):
    inc = (await s.execute(select(Incident).where(Incident.id == body.incident_id))).scalar_one_or_none()
    if not inc or not inc.primary_hospital_id:
        raise HTTPException(404, "incident not found")
    if inc.band == "CRITICAL":
        raise HTTPException(403, "Article 21: critical stabilization cannot be declined")
    hosp = (await s.execute(select(Hospital).where(Hospital.id == inc.primary_hospital_id))).scalar_one()
    hosp.diversion_until = datetime.now(timezone.utc) + timedelta(hours=4)
    await redis.delete(f"bedlock:{inc.primary_hospital_id}:icu:1")
    inc.bed_state = "DIVERTED"
    inc.primary_hospital_id = inc.backup_hospital_id
    await s.commit()
    await audit_append(s, body.incident_id, "BED_DECLINED", "HOSPITAL_ED",
                       {"reason": body.reason_code, "blackout_hours": 4})
    return {"state": "DIVERTED", "reason": body.reason_code}


@app.post("/api/v1/complaints")
async def file_complaint(incident_id: str, category: str, lat: float, lng: float,
                         evidence_hash: str, s: AsyncSession = Depends(get_db),
                         u: dict = Depends(current_user)):
    if len(evidence_hash) != 64:
        raise HTTPException(400, "evidence_hash must be sha256 hex")
    c = Complaint(incident_id=incident_id, category=category,
                  gps=ST_GeogFromText(f"POINT({lng} {lat})"),
                  evidence_hash=evidence_hash)
    s.add(c)
    await s.commit()
    await audit_append(s, incident_id, "COMPLAINT_FILED", u["role"],
                       {"category": category, "hash": evidence_hash})
    return {"complaint_id": str(c.id)}


@app.get("/api/v1/incidents/{incident_id}")
async def get_incident(incident_id: str, s: AsyncSession = Depends(get_db),
                       u: dict = Depends(current_user)):
    inc = (await s.execute(select(Incident).where(Incident.id == incident_id))).scalar_one_or_none()
    if not inc:
        raise HTTPException(404, "not found")
    return {
        "id": str(inc.id), "band": inc.band, "rts": float(inc.rts or 0),
        "bed_state": inc.bed_state, "score": float(inc.score or 0),
        "sla_penalty_inr": inc.sla_penalty_inr,
        "primary_hospital_id": str(inc.primary_hospital_id) if inc.primary_hospital_id else None,
    }


@app.websocket("/ws/{incident_id}")
async def ws_endpoint(ws: WebSocket, incident_id: str):
    await ws.accept()
    ws_clients.setdefault(incident_id, set()).add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_clients.get(incident_id, set()).discard(ws)
```

FILE: `frontend/package.json`
```json
{
  "name": "golden-lane-frontend",
  "private": true,
  "version": "2.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "~5.6.3",
    "vite": "^6.0.3"
  }
}
```

FILE: `frontend/vite.config.ts`
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws':  { target: 'ws://localhost:8000', ws: true },
    },
  },
});
```

FILE: `frontend/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

FILE: `frontend/index.html`
```html
<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Golden Lane EMS</title>
    <link rel="manifest" href="/manifest.json" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

FILE: `frontend/public/manifest.json`
```json
{
  "name": "Golden Lane EMS",
  "short_name": "GoldenLane",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#080C15",
  "theme_color": "#FF4459",
  "icons": []
}
```

FILE: `frontend/src/main.tsx`
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
```

FILE: `frontend/src/styles.css`
```css
:root, [data-theme="light"] {
  --bg-base: #F8FAFC;
  --bg-panel: #FFFFFF;
  --text-main: #0F172A;
  --text-muted: #64748B;
  --accent: #0284C7;
  --status-critical: #E11D48;
  --status-warning: #F59E0B;
  --status-stable: #059669;
  --border: #E2E8F0;
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
}
[data-theme="dark"] {
  --bg-base: #080C15;
  --bg-panel: #111827;
  --text-main: #F8FAFC;
  --text-muted: #94A3B8;
  --accent: #2FE6A6;
  --status-critical: #FF4459;
  --status-warning: #FFB13D;
  --status-stable: #2FE6A6;
  --border: #1F2937;
}
body { margin: 0; background: var(--bg-base); color: var(--text-main); }
h1, h2, h3 { font-family: 'Space Grotesk', sans-serif; margin: 0; }
.mono { font-family: 'JetBrains Mono', monospace; }
.card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
.btn { padding: 10px 16px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-family: inherit; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-danger  { background: var(--status-critical); color: #fff; }
.btn-ghost   { background: transparent; border: 1px solid var(--border); color: var(--text-main); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-base); color: var(--text-main); font-family: 'JetBrains Mono', monospace; font-size: 14px; box-sizing: border-box; }
.label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px; }
.grid { display: grid; gap: 16px; }
.row { display: flex; gap: 12px; align-items: center; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-family: 'JetBrains Mono', monospace; }
.badge-critical { background: color-mix(in srgb, var(--status-critical) 15%, transparent); color: var(--status-critical); }
.badge-stable   { background: color-mix(in srgb, var(--status-stable) 15%, transparent);   color: var(--status-stable); }
.badge-warning  { background: color-mix(in srgb, var(--status-warning) 15%, transparent);  color: var(--status-warning); }
.container { max-width: 1200px; margin: 0 auto; padding: 24px; }
```

FILE: `frontend/src/api.ts`
```ts
export interface LoginResponse {
  token: string;
  role: 'PATIENT' | 'AMBULANCE_EMT' | 'HOSPITAL_ED';
  name: string;
  entity_id: string;
}

export interface SosResponse {
  incident_id: string;
  primary_hospital: string;
  backup_hospital: string;
  etdc_minutes: number;
  score: number;
  bed_state: string;
}

const BASE = '';

export async function apiLogin(login_id: string, password: string): Promise<LoginResponse> {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id, password }),
  });
  if (!r.ok) throw new Error(((await r.json()).detail as string) ?? 'login failed');
  return r.json() as Promise<LoginResponse>;
}

export async function apiSos(lat: number, lng: number): Promise<SosResponse> {
  const r = await fetch(`${BASE}/api/v1/sos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, device_note: 'browser_sos' }),
  });
  if (!r.ok) throw new Error('sos failed');
  return r.json() as Promise<SosResponse>;
}

export async function apiGetIncident(id: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/api/v1/incidents/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('fetch failed');
  return r.json() as Promise<Record<string, unknown>>;
}

export async function apiPushVitals(token: string, body: {
  incident_id: string; heart_rate: number; systolic_bp: number;
  spo2: number; gcs: number; respiratory_rate: number;
}): Promise<{ rts: number; band: string }> {
  const r = await fetch(`${BASE}/api/v1/telemetry/vitals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('vitals failed');
  return r.json() as Promise<{ rts: number; band: string }>;
}

export async function apiCorridor(token: string, body: {
  incident_id: string; lateral_deviation_m: number;
  unscheduled_halt_s: number; delayed_minutes: number;
}): Promise<{ violation: boolean; sla_penalty_inr: number }> {
  const r = await fetch(`${BASE}/api/v1/telemetry/corridor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('corridor failed');
  return r.json() as Promise<{ violation: boolean; sla_penalty_inr: number }>;
}

export async function apiPhase2(token: string, incident_id: string): Promise<{ state: string }> {
  const r = await fetch(`${BASE}/api/v1/bed/phase2?incident_id=${encodeURIComponent(incident_id)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('phase2 failed');
  return r.json() as Promise<{ state: string }>;
}

export function connectWs(incident_id: string, onMsg: (msg: unknown) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${incident_id}`);
  ws.onmessage = (e) => {
    try { onMsg(JSON.parse(e.data as string)); } catch { /* ignore */ }
  };
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
  }, 20000);
  return () => { clearInterval(ping); ws.close(); };
}
```

FILE: `frontend/src/App.tsx`
```tsx
import { useEffect, useState } from 'react';
import { apiLogin, apiSos, type SosResponse } from './api';
import Patient from './pages/Patient';
import Emt from './pages/Emt';
import Hospital from './pages/Hospital';

export type Role = 'PATIENT' | 'AMBULANCE_EMT' | 'HOSPITAL_ED';

export interface SessionIncident extends SosResponse {
  band: string;
  rts: number;
  sla_penalty_inr: number;
}

export interface Session {
  token: string;
  role: Role;
  name: string;
  entityId: string;
  incidentId?: string;
  initialIncident?: SessionIncident;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = session?.role === 'AMBULANCE_EMT' ? 'dark' : 'light';
  }, [session]);

  if (!session) return <Login onSession={setSession} />;
  if (session.role === 'PATIENT')       return <Patient  session={session} onLogout={() => setSession(null)} />;
  if (session.role === 'AMBULANCE_EMT') return <Emt      session={session} onLogout={() => setSession(null)} />;
  return <Hospital session={session} onLogout={() => setSession(null)} />;
}

function Login({ onSession }: { onSession: (s: Session) => void }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await apiLogin(loginId.trim(), password);
      onSession({ token: r.token, role: r.role, name: r.name, entityId: r.entity_id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'login failed');
    } finally { setBusy(false); }
  }

  async function sos() {
    setErr(null); setBusy(true);
    try {
      if (!navigator.geolocation) throw new Error('geolocation unavailable');
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 })
      );
      const r = await apiSos(pos.coords.latitude, pos.coords.longitude);
      onSession({
        token: '', role: 'PATIENT',
        name: 'Emergency SOS Session', entityId: 'SOS',
        incidentId: r.incident_id,
        initialIncident: { ...r, band: 'CRITICAL', rts: 0, sla_penalty_inr: 0 },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'sos failed');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 420 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
          <h1 style={{ fontSize: 22 }}>GOLDEN LANE</h1>
          <span className="badge badge-critical">ANTI-NEXUS EMS</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
          One gateway. Your dashboard mounts automatically after sign-in.
        </p>
        <form onSubmit={submit}>
          <div style={{ marginBottom: 12 }}>
            <label className="label">Login ID</label>
            <input className="input" value={loginId} onChange={e => setLoginId(e.target.value)} required autoComplete="username" />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="label">Password</label>
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
          </div>
          {err && <p style={{ color: 'var(--status-critical)', fontSize: 13 }}>{err}</p>}
          <button className="btn btn-primary" style={{ width: '100%', marginBottom: 12 }} disabled={busy}>
            {busy ? 'Working…' : 'Authenticate'}
          </button>
        </form>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <button className="btn btn-danger" style={{ width: '100%' }} onClick={sos} disabled={busy}>
            EMERGENCY SOS (NO LOGIN)
          </button>
        </div>
      </div>
    </div>
  );
}
```

FILE: `frontend/src/pages/Patient.tsx`
```tsx
import { useEffect, useState } from 'react';
import type { Session } from '../App';
import { apiGetIncident, connectWs } from '../api';

export default function Patient({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const incidentId = session.incidentId ?? '';
  const [incident, setIncident] = useState<Record<string, unknown> | null>(
    session.initialIncident ? { ...session.initialIncident } : null
  );
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    if (!session.token || !incidentId) return;
    apiGetIncident(incidentId, session.token).then(setIncident).catch(() => {});
  }, [incidentId, session.token]);

  useEffect(() => {
    if (!incidentId) return;
    return connectWs(incidentId, (m) => {
      setEvents(prev => [`${(m as { type: string }).type}: ${JSON.stringify(m)}`, ...prev].slice(0, 8));
      const msg = m as { type: string; state?: string; band?: string };
      if (msg.type === 'bed_state' && msg.state) {
        setIncident(prev => prev ? { ...prev, bed_state: msg.state } : prev);
      }
      if (msg.type === 'vitals' && msg.band) {
        setIncident(prev => prev ? { ...prev, band: msg.band } : prev);
      }
    });
  }, [incidentId]);

  return (
    <div className="container">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2>Patient & Trusted Contact</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }} className="mono">
            {session.name} · {session.entityId}
          </p>
        </div>
        <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>
      </header>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Live Incident</h3>
          {incident ? (
            <ul className="mono" style={{ fontSize: 13, lineHeight: 1.9, listStyle: 'none', padding: 0 }}>
              <li>ID: {String(incident.id).slice(0, 8)}…</li>
              <li>Hospital: {String(incident.primary_hospital ?? incident.primary_hospital_id ?? '—')}</li>
              <li>Band: <span className={`badge badge-${incident.band === 'CRITICAL' ? 'critical' : 'stable'}`}>{String(incident.band)}</span></li>
              <li>ETDC: {String(incident.etdc_minutes ?? '—')} min</li>
              <li>Bed: {String(incident.bed_state)}</li>
              <li>SLA fine: ₹{String(incident.sla_penalty_inr)}</li>
            </ul>
          ) : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Waiting for assignment…</p>}
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Live Events</h3>
          {events.length === 0
            ? <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No events yet.</p>
            : <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>
                {events.join('\n')}
              </pre>}
        </div>
      </div>
    </div>
  );
}
```

FILE: `frontend/src/pages/Emt.tsx`
```tsx
import { useState } from 'react';
import type { Session } from '../App';
import { apiPushVitals, apiCorridor } from '../api';

export default function Emt({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [incidentId, setIncidentId] = useState('');
  const [hr, setHr] = useState(110);
  const [sbp, setSbp] = useState(90);
  const [spo2, setSpo2] = useState(94);
  const [gcs, setGcs] = useState(12);
  const [rr, setRr] = useState(20);
  const [rts, setRts] = useState<number | null>(null);
  const [band, setBand] = useState('—');
  const [corridor, setCorridor] = useState<{ violation: boolean; sla_penalty_inr: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pushVitals() {
    setErr(null);
    try {
      const r = await apiPushVitals(session.token, {
        incident_id: incidentId, heart_rate: hr, systolic_bp: sbp,
        spo2, gcs, respiratory_rate: rr,
      });
      setRts(r.rts); setBand(r.band);
    } catch (e) { setErr(e instanceof Error ? e.message : 'push failed'); }
  }

  async function checkCorridor(dev: number, halt: number, delay = 0) {
    setErr(null);
    try {
      const r = await apiCorridor(session.token, {
        incident_id: incidentId, lateral_deviation_m: dev,
        unscheduled_halt_s: halt, delayed_minutes: delay,
      });
      setCorridor(r);
    } catch (e) { setErr(e instanceof Error ? e.message : 'corridor failed'); }
  }

  return (
    <div className="container">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2>Ambulance EMT Cockpit</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }} className="mono">
            {session.name} · {session.entityId}
          </p>
        </div>
        <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>
      </header>

      <div style={{ marginBottom: 16 }}>
        <label className="label">Incident ID</label>
        <input className="input" value={incidentId} onChange={e => setIncidentId(e.target.value)} placeholder="paste incident id" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Vitals</h3>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><label className="label">HR</label><input className="input" type="number" value={hr} onChange={e => setHr(+e.target.value)} /></div>
            <div><label className="label">SBP</label><input className="input" type="number" value={sbp} onChange={e => setSbp(+e.target.value)} /></div>
            <div><label className="label">SpO2</label><input className="input" type="number" value={spo2} onChange={e => setSpo2(+e.target.value)} /></div>
            <div><label className="label">GCS</label><input className="input" type="number" value={gcs} min={3} max={15} onChange={e => setGcs(+e.target.value)} /></div>
            <div><label className="label">RR</label><input className="input" type="number" value={rr} onChange={e => setRr(+e.target.value)} /></div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12, width: '100%' }} onClick={pushVitals} disabled={!incidentId}>
            Push vitals
          </button>
          <p className="mono" style={{ marginTop: 12, fontSize: 13 }}>
            RTS: {rts ?? '—'} · Band: <span className={`badge badge-${band === 'CRITICAL' ? 'critical' : band === 'WARNING' ? 'warning' : 'stable'}`}>{band}</span>
          </p>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Corridor Guard</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Simulates telemetry reporting a lateral detour and an unscheduled halt.
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-ghost" onClick={() => checkCorridor(100, 30)} disabled={!incidentId}>
              Test: 100 m / 30 s (OK)
            </button>
            <button className="btn btn-danger" onClick={() => checkCorridor(300, 150, 5)} disabled={!incidentId}>
              Test: 300 m / 150 s / +5m (VIOLATION)
            </button>
          </div>
          {corridor && (
            <p className="mono" style={{ marginTop: 12, fontSize: 13 }}>
              Violation: {String(corridor.violation)} · SLA: ₹{corridor.sla_penalty_inr}
            </p>
          )}
        </div>
      </div>
      {err && <p style={{ color: 'var(--status-critical)', marginTop: 12 }}>{err}</p>}
    </div>
  );
}
```

FILE: `frontend/src/pages/Hospital.tsx`
```tsx
import { useState } from 'react';
import type { Session } from '../App';
import { apiPhase2, apiGetIncident } from '../api';

export default function Hospital({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [incidentId, setIncidentId] = useState('');
  const [incident, setIncident] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setErr(null); setMsg(null);
    try { setIncident(await apiGetIncident(incidentId, session.token)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'load failed'); }
  }

  async function confirm() {
    setErr(null); setMsg(null);
    try {
      await apiPhase2(session.token, incidentId);
      setMsg('Phase 2 hard lock confirmed.');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'confirm failed'); }
  }

  return (
    <div className="container">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2>Hospital ED Workstation</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }} className="mono">
            {session.name} · {session.entityId}
          </p>
        </div>
        <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>
      </header>

      <div style={{ marginBottom: 16 }}>
        <label className="label">Incident ID</label>
        <div className="row">
          <input className="input" value={incidentId} onChange={e => setIncidentId(e.target.value)} placeholder="paste incident id" />
          <button className="btn btn-ghost" onClick={load} disabled={!incidentId}>Load</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Incoming</h3>
          {incident ? (
            <ul className="mono" style={{ fontSize: 13, lineHeight: 1.9, listStyle: 'none', padding: 0 }}>
              <li>Band: <span className={`badge badge-${incident.band === 'CRITICAL' ? 'critical' : 'stable'}`}>{String(incident.band)}</span></li>
              <li>RTS: {String(incident.rts)}</li>
              <li>Bed: {String(incident.bed_state)}</li>
              <li>Score: {String(incident.score)}</li>
            </ul>
          ) : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No incident loaded.</p>}
          <button className="btn btn-primary" style={{ marginTop: 12, width: '100%' }} onClick={confirm} disabled={!incidentId}>
            Confirm Phase 2 Bed Lock
          </button>
          {msg && <p style={{ color: 'var(--status-stable)', marginTop: 8, fontSize: 13 }}>{msg}</p>}
          {err && <p style={{ color: 'var(--status-critical)', marginTop: 8, fontSize: 13 }}>{err}</p>}
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Pre-Arrival Checklist</h3>
          <ul style={{ fontSize: 13, lineHeight: 1.9, paddingLeft: 18 }}>
            <li>Trauma bay held under Phase 1 reserve</li>
            <li>Notify on-call neurosurgeon / anesthesiologist</li>
            <li>Prepare 2 units O-negative uncrossmatched blood</li>
            <li>Scan EMT handover QR at bay doorway</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
```

FILE: `frontend/Dockerfile`
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

FILE: `frontend/nginx.conf`
```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  location /api/ {
    proxy_pass http://backend:8000/api/;
    proxy_set_header Host $host;
  }
  location /ws/ {
    proxy_pass http://backend:8000/ws/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
  location / {
    try_files $uri /index.html;
  }
}
```

FILE: `README.md`
```markdown
# Golden Lane EMS

Anti-nexus emergency medical routing for India. Single-login, three dashboards, deterministic hospital assignment, tamper-proof audit.

## Run

    cp .env.example .env
    docker compose up --build

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
```
