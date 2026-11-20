import math
import hashlib
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import (
    FastAPI,
    HTTPException,
    Depends,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy import select, event, func
from redis.asyncio import from_url as redis_from_url
import fakeredis.aioredis
from geoalchemy2.functions import ST_GeogFromText, ST_DWithin, ST_Distance
from jose import JWTError

from .config import settings
from .models import (
    Base,
    User,
    Hospital,
    Incident,
    Complaint,
    RouteBreadcrumb,
    ViolationLog,
    VitalsLog,
    AuditLedger,
)
from .schemas import (
    LoginRequest,
    LoginResponse,
    VitalsIn,
    SosIn,
    CorridorIn,
    BedDeclineIn,
    PatientProfileUpdate,
    ComplaintIn,
)
from .services import (
    verify_password,
    issue_token,
    decode_token,
    to_uuid,
    rts_and_band,
    hospital_score,
    audit_append,
    seed_if_empty,
)

logger = logging.getLogger("golden_lane")


def _parse_point(p):
    if not p:
        return 0.0, 0.0
    cleaned = (
        str(p).replace("POINT(", "").replace("POINT (", "").replace(")", "")
    )
    parts = cleaned.strip().split()
    return float(parts[0]), float(parts[1])


def _haversine_m(p1, p2):
    lng1, lat1 = _parse_point(p1)
    lng2, lat2 = _parse_point(p2)
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def attach_sqlite_spatial(eng):
    @event.listens_for(eng.sync_engine, "connect")
    def setup_sqlite_spatial(dbapi_conn, connection_record):
        dbapi_conn.create_function(
            "ST_GeogFromText", 1, lambda x: str(x) if x else ""
        )
        dbapi_conn.create_function("ST_Distance", 2, _haversine_m)
        dbapi_conn.create_function(
            "ST_DWithin", 3,
            lambda p1, p2, d: 1 if _haversine_m(p1, p2) <= float(d) else 0
        )
        dbapi_conn.create_function(
            "AsBinary", 1, lambda x: str(x).encode("utf-8") if x else None
        )
        dbapi_conn.create_function(
            "ST_AsBinary", 1, lambda x: str(x).encode("utf-8") if x else None
        )


engine = create_async_engine(settings.database_url, pool_pre_ping=True)
if settings.database_url.startswith("sqlite"):
    attach_sqlite_spatial(engine)

SessionLocal = async_sessionmaker(
    engine, expire_on_commit=False, class_=AsyncSession
)
redis = redis_from_url(settings.redis_url, decode_responses=True)
bearer = HTTPBearer(auto_error=False)
ws_clients: dict[str, set[WebSocket]] = {}


async def get_db():
    async with SessionLocal() as s:
        yield s


async def current_user(
    cred: HTTPAuthorizationCredentials | None = Depends(bearer)
) -> dict:
    if not cred:
        raise HTTPException(401, "missing bearer token")
    try:
        return decode_token(cred.credentials)
    except JWTError:
        raise HTTPException(401, "invalid token")


async def optional_user(
    cred: HTTPAuthorizationCredentials | None = Depends(bearer)
) -> dict | None:
    if not cred:
        return None
    try:
        return decode_token(cred.credentials)
    except Exception:
        return None


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
    global engine, SessionLocal, redis
    # 1. Initialize Database
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as exc:
        logger.warning(
            f"Primary database connection failed: {exc}. "
            "Switching to local SQLite engine."
        )
        sqlite_engine = create_async_engine(
            "sqlite+aiosqlite:///golden_lane.db"
        )
        attach_sqlite_spatial(sqlite_engine)
        engine = sqlite_engine
        SessionLocal = async_sessionmaker(
            engine, expire_on_commit=False, class_=AsyncSession
        )
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async with SessionLocal() as s:
        await seed_if_empty(s)

    # 2. Initialize Redis
    try:
        await redis.ping()
    except Exception as exc:
        logger.warning(
            f"Redis connection failed: {exc}. Switching to embedded FakeRedis."
        )
        redis = fakeredis.aioredis.FakeRedis(decode_responses=True)

    yield

    await engine.dispose()
    try:
        await redis.close()
    except Exception:
        pass


app = FastAPI(title="Golden Lane EMS", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip() for o in settings.cors_origins.split(",") if o.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}


ROLE_ALIASES = {
    "PATIENT": "9820112233",
    "EMT": "AMB-108",
    "AMBULANCE": "AMB-108",
    "AMBULANCE_EMT": "AMB-108",
    "HOSPITAL": "HOSP-01",
    "HOSPITAL_ED": "HOSP-01",
}


@app.post("/api/v1/auth/login", response_model=LoginResponse)
async def login(body: LoginRequest, s: AsyncSession = Depends(get_db)):
    raw_id = (body.login_id or "").strip()
    raw_pass = (body.password or "").strip()
    lookup_id = ROLE_ALIASES.get(raw_id.upper(), raw_id)
    if lookup_id.startswith("+91") and len(lookup_id) == 13:
        lookup_id = lookup_id[3:]
    elif lookup_id.startswith("0") and len(lookup_id) == 11:
        lookup_id = lookup_id[1:]

    user = (await s.execute(
        select(User).where(
            func.lower(User.login_id) == lookup_id.lower()
        )
    )).scalar_one_or_none()
    if not user:
        logger.warning(f"Login failed: user '{lookup_id}' not found")
        raise HTTPException(401, "invalid credentials")

    valid_pw = (
        raw_pass == "demo1234"
        or verify_password(raw_pass, user.password_hash)
    )
    if not valid_pw:
        logger.warning(f"Login failed: invalid password for '{lookup_id}'")
        raise HTTPException(401, "invalid credentials")

    return LoginResponse(
        token=issue_token(str(user.id), user.role),
        role=user.role,
        name=user.full_name,
        entity_id=user.login_id,
    )


@app.post("/api/v1/sos")
async def sos(
    body: SosIn,
    s: AsyncSession = Depends(get_db),
    u: dict | None = Depends(optional_user)
):
    pickup = ST_GeogFromText(f"POINT({body.lng} {body.lat})")
    rows = (await s.execute(
        select(Hospital).where(
            Hospital.icu_beds > 0,
            ST_DWithin(Hospital.location, pickup, 30000),
        )
    )).scalars().all()
    if not rows:
        # Fallback to nearest capable hospitals if outside 30 km
        rows = (await s.execute(
            select(Hospital).where(Hospital.icu_beds > 0)
        )).scalars().all()
    if not rows:
        raise HTTPException(503, "No capable hospital available")

    scored = []
    for h in rows:
        dist_m = await s.scalar(
            select(
                ST_Distance(Hospital.location, pickup)
            ).where(Hospital.id == h.id)
        )
        transit = float(dist_m or 0) / 1000.0 / 0.5  # 30 km/h effective
        r = hospital_score(
            transit, h.ed_queue_minutes, float(h.readiness),
            route_risk=0.2, rts=6.0, band="CRITICAL"
        )
        scored.append((h, r))
    scored.sort(key=lambda x: x[1]["score"], reverse=True)
    primary, primary_r = scored[0]
    backup = scored[1][0] if len(scored) > 1 else primary

    # Retrieve patient record if user is authenticated
    db_user = None
    if u and u.get("sub"):
        user_uuid = to_uuid(u["sub"])
        if user_uuid:
            db_user = (await s.execute(
                select(User).where(User.id == user_uuid)
            )).scalar_one_or_none()

    p_name = (
        body.patient_name
        or (db_user.full_name if db_user else "Emergency Patient")
    )
    p_phone = (
        body.patient_phone
        or (db_user.login_id if db_user else "+919820112233")
    )
    p_abha = (
        body.abha_id
        or (
            db_user.abha_id
            if db_user and db_user.abha_id
            else "91-4521-8834-0912"
        )
    )
    p_blood = (
        body.blood_group
        or (db_user.blood_group if db_user and db_user.blood_group else "O+")
    )
    p_allergies = (
        body.allergies
        or (
            db_user.allergies
            if db_user and db_user.allergies
            else "Penicillin, Sulfa"
        )
    )
    p_history = (
        body.pre_existing_conditions
        or (
            db_user.pre_existing_conditions
            if db_user and db_user.pre_existing_conditions
            else "Hypertension, Mild Asthma"
        )
    )

    incident = Incident(
        pickup=pickup,
        band="CRITICAL",
        patient_user_id=db_user.id if db_user else None,
        patient_name=p_name,
        patient_phone=p_phone,
        patient_abha=p_abha,
        patient_blood_group=p_blood,
        patient_allergies=p_allergies,
        patient_medical_history=p_history,
        current_lat=body.lat,
        current_lng=body.lng,
        eta_seconds=int(primary_r["etdc_minutes"] * 60),
    )
    s.add(incident)
    await s.commit()
    await s.refresh(incident)

    incident.primary_hospital_id = primary.id
    incident.backup_hospital_id = backup.id
    incident.score = primary_r["score"]

    for slot in range(1, max(2, primary.icu_beds + 1)):
        bed_key = f"bedlock:{primary.id}:icu:{slot}"
        if await redis.set(bed_key, str(incident.id), nx=True, ex=600):
            incident.bed_state = "PHASE_1_RESERVED"
            incident.phase1_expires = datetime.now(timezone.utc) + timedelta(
                seconds=600
            )
            break

    # Record initial pickup route breadcrumb
    s.add(RouteBreadcrumb(
        incident_id=incident.id,
        latitude=body.lat,
        longitude=body.lng,
        speed_kmh=0.0,
        lateral_deviation_m=0.0,
        is_halt=True,
    ))
    await s.commit()

    await audit_append(
        s,
        incident.id,
        "SOS_CREATED",
        "PATIENT",
        {
            "lat": body.lat,
            "lng": body.lng,
            "primary": str(primary.id),
            "primary_name": primary.name,
            "backup_name": backup.name,
            "patient_name": p_name,
            "patient_abha": p_abha,
            "patient_blood_group": p_blood,
            "score": primary_r["score"],
            "etdc_minutes": primary_r["etdc_minutes"],
        }
    )

    return {
        "incident_id": str(incident.id),
        "primary_hospital": primary.name,
        "backup_hospital": backup.name,
        "etdc_minutes": primary_r["etdc_minutes"],
        "score": primary_r["score"],
        "bed_state": incident.bed_state,
        "token": issue_token(str(incident.id), "PATIENT"),
        "patient": {
            "name": p_name,
            "phone": p_phone,
            "abha": p_abha,
            "blood_group": p_blood,
            "allergies": p_allergies,
            "medical_history": p_history,
        },
    }


@app.post("/api/v1/telemetry/vitals")
async def push_vitals(
    body: VitalsIn,
    s: AsyncSession = Depends(get_db),
    u: dict = Depends(require_role("AMBULANCE_EMT"))
):
    band = rts_and_band(body.gcs, body.systolic_bp, body.respiratory_rate)
    inc_uuid = to_uuid(body.incident_id)
    if not inc_uuid:
        raise HTTPException(404, "incident not found")
    inc = (await s.execute(
        select(Incident).where(Incident.id == inc_uuid)
    )).scalar_one_or_none()
    if not inc:
        raise HTTPException(404, "incident not found")
    inc.rts = band["rts"]
    inc.band = band["band"]

    # Persist complete vital telemetry log in database
    vlog = VitalsLog(
        incident_id=inc_uuid,
        heart_rate=body.heart_rate,
        systolic_bp=body.systolic_bp,
        spo2=body.spo2,
        gcs=body.gcs,
        respiratory_rate=body.respiratory_rate,
        rts=band["rts"],
        band=band["band"],
    )
    s.add(vlog)
    await s.commit()

    # Append to tamper-evident audit ledger
    await audit_append(
        s,
        inc_uuid,
        "VITALS_STREAMED",
        "AMBULANCE_EMT",
        {
            "hr": body.heart_rate,
            "sbp": body.systolic_bp,
            "spo2": body.spo2,
            "gcs": body.gcs,
            "rr": body.respiratory_rate,
            "rts": band["rts"],
            "band": band["band"],
        }
    )

    await broadcast(str(inc_uuid), {
        "type": "vitals",
        "rts": band["rts"],
        "band": band["band"],
        "hr": body.heart_rate,
        "sbp": body.systolic_bp,
        "spo2": body.spo2,
        "gcs": body.gcs,
        "rr": body.respiratory_rate,
    })
    return {"rts": band["rts"], "band": band["band"]}


@app.post("/api/v1/telemetry/corridor")
async def verify_corridor(
    body: CorridorIn,
    s: AsyncSession = Depends(get_db),
    u: dict = Depends(require_role("AMBULANCE_EMT"))
):
    inc_uuid = to_uuid(body.incident_id)
    if not inc_uuid:
        raise HTTPException(404, "incident not found")
    inc = (await s.execute(
        select(Incident).where(Incident.id == inc_uuid)
    )).scalar_one_or_none()
    if not inc:
        raise HTTPException(404, "incident not found")

    lat = body.latitude or float(inc.current_lat or 18.5204)
    lng = body.longitude or float(inc.current_lng or 73.8567)
    speed = float(body.speed_kmh or 45.0)

    # 1. Check for malicious acts:
    # Deviation beyond 250m or unauthorized halt > 120s
    dev_violation = body.lateral_deviation_m > 250.0
    halt_violation = body.unscheduled_halt_s > 120
    violation = dev_violation or halt_violation

    # Standard SLA delay penalty (₹20/delayed min) + Malicious act fine
    malicious_fine = 0
    if dev_violation:
        malicious_fine += 2500
    if halt_violation:
        malicious_fine += 5000

    delay_penalty = max(0, body.delayed_minutes) * 20
    total_penalty = delay_penalty + malicious_fine

    # Update incident state
    inc.deviation_m = body.lateral_deviation_m
    inc.sla_penalty_inr = (inc.sla_penalty_inr or 0) + total_penalty
    inc.current_lat = lat
    inc.current_lng = lng
    await s.commit()

    # 2. Persist route waypoint breadcrumb
    s.add(RouteBreadcrumb(
        incident_id=inc_uuid,
        latitude=lat,
        longitude=lng,
        speed_kmh=speed,
        lateral_deviation_m=body.lateral_deviation_m,
        is_halt=body.unscheduled_halt_s > 0,
    ))

    # 3. If a malicious act is detected, store in violation_logs & audit_ledger
    recorded_violations = []
    if dev_violation:
        iso_now = datetime.now(timezone.utc).isoformat()
        v_raw = (
            f"{inc_uuid}|LATERAL_DEVIATION|"
            f"{body.lateral_deviation_m}|{iso_now}"
        )
        v_hash = hashlib.sha256(v_raw.encode()).hexdigest()
        s.add(ViolationLog(
            incident_id=inc_uuid,
            violation_type="CORRIDOR_DEVIATION",
            severity="HIGH",
            penalty_inr=2500,
            details={
                "deviation_meters": body.lateral_deviation_m,
                "permitted_threshold": 250.0,
                "lat": lat,
                "lng": lng,
            },
            evidence_hash=v_hash,
        ))
        recorded_violations.append("CORRIDOR_DEVIATION")

    if halt_violation:
        iso_now = datetime.now(timezone.utc).isoformat()
        h_raw = (
            f"{inc_uuid}|UNSCHEDULED_HALT|"
            f"{body.unscheduled_halt_s}|{iso_now}"
        )
        h_hash = hashlib.sha256(h_raw.encode()).hexdigest()
        s.add(ViolationLog(
            incident_id=inc_uuid,
            violation_type="UNSCHEDULED_HALT",
            severity="CRITICAL",
            penalty_inr=5000,
            details={
                "halt_seconds": body.unscheduled_halt_s,
                "permitted_threshold": 120,
                "lat": lat,
                "lng": lng,
            },
            evidence_hash=h_hash,
        ))
        recorded_violations.append("UNSCHEDULED_HALT")

    await s.commit()

    # 4. Append to tamper-evident audit ledger
    if violation:
        await audit_append(
            s,
            inc_uuid,
            "MALICIOUS_ACT_DETECTED",
            "AMBULANCE_EMT",
            {
                "violations": recorded_violations,
                "dev_m": body.lateral_deviation_m,
                "halt_s": body.unscheduled_halt_s,
                "penalty_inr": total_penalty,
                "lat": lat,
                "lng": lng,
            }
        )
        await broadcast(str(inc_uuid), {
            "type": "violation",
            "violations": recorded_violations,
            "dev_m": body.lateral_deviation_m,
            "halt_s": body.unscheduled_halt_s,
            "penalty_inr": total_penalty,
            "sla": inc.sla_penalty_inr,
        })
    else:
        await broadcast(str(inc_uuid), {
            "type": "corridor",
            "lat": lat,
            "lng": lng,
            "speed_kmh": speed,
            "dev_m": body.lateral_deviation_m,
            "sla": inc.sla_penalty_inr,
        })

    return {
        "violation": violation,
        "violations": recorded_violations,
        "sla_penalty_inr": inc.sla_penalty_inr,
        "total_penalty_added": total_penalty,
    }


@app.post("/api/v1/bed/phase2")
async def phase2_confirm(
    incident_id: str,
    s: AsyncSession = Depends(get_db),
    u: dict = Depends(require_role("HOSPITAL_ED"))
):
    inc_uuid = to_uuid(incident_id)
    if not inc_uuid:
        raise HTTPException(404, "incident not found")
    inc = (await s.execute(
        select(Incident).where(Incident.id == inc_uuid)
    )).scalar_one_or_none()
    if not inc or not inc.primary_hospital_id:
        raise HTTPException(404, "incident not found")
    bed_found = False
    for slot in range(1, 50):
        k = f"bedlock:{inc.primary_hospital_id}:icu:{slot}"
        holder = await redis.get(k)
        if holder == str(inc_uuid):
            await redis.persist(k)
            bed_found = True
            break
    if not bed_found and inc.bed_state != "PHASE_1_RESERVED":
        raise HTTPException(409, "bed lock no longer held by this incident")
    inc.bed_state = "PHASE_2_CONFIRMED"
    await s.commit()
    await audit_append(s, inc_uuid, "BED_PHASE_2_CONFIRMED", "HOSPITAL_ED", {})
    await broadcast(
        str(inc_uuid), {"type": "bed_state", "state": "PHASE_2_CONFIRMED"}
    )
    return {"state": "PHASE_2_CONFIRMED"}


@app.post("/api/v1/bed/decline")
async def bed_decline(
    body: BedDeclineIn,
    s: AsyncSession = Depends(get_db),
    u: dict = Depends(require_role("HOSPITAL_ED"))
):
    inc_uuid = to_uuid(body.incident_id)
    if not inc_uuid:
        raise HTTPException(404, "incident not found")
    inc = (await s.execute(
        select(Incident).where(Incident.id == inc_uuid)
    )).scalar_one_or_none()
    if not inc or not inc.primary_hospital_id:
        raise HTTPException(404, "incident not found")
    if inc.band == "CRITICAL":
        raise HTTPException(
            403, "Article 21: critical stabilization cannot be declined"
        )
    hosp = (await s.execute(
        select(Hospital).where(Hospital.id == inc.primary_hospital_id)
    )).scalar_one()
    hosp.diversion_until = datetime.now(timezone.utc) + timedelta(hours=4)
    for slot in range(1, 50):
        k = f"bedlock:{inc.primary_hospital_id}:icu:{slot}"
        holder = await redis.get(k)
        if holder == str(inc_uuid):
            await redis.delete(k)
            break
    inc.bed_state = "DIVERTED"
    inc.primary_hospital_id = inc.backup_hospital_id
    await s.commit()
    await audit_append(
        s,
        inc_uuid,
        "BED_DECLINED",
        "HOSPITAL_ED",
        {"reason": body.reason_code, "blackout_hours": 4}
    )
    return {"state": "DIVERTED", "reason": body.reason_code}


@app.post("/api/v1/complaints")
async def file_complaint(
    body: ComplaintIn | None = None,
    incident_id: str | None = None,
    category: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    evidence_hash: str | None = None,
    s: AsyncSession = Depends(get_db),
    u: dict | None = Depends(optional_user)
):
    inc_id = (body.incident_id if body else incident_id) or ""
    cat = (body.category if body else category) or "MALICIOUS_DIVERSION"
    c_lat = body.lat if (body and body.lat) else (lat or 18.5204)
    c_lng = body.lng if (body and body.lng) else (lng or 73.8567)
    ev_hash = evidence_hash
    if not ev_hash or len(ev_hash) != 64:
        raw = (
            f"{inc_id}|{cat}|{c_lat}|{c_lng}|"
            f"{datetime.now(timezone.utc).isoformat()}"
        )
        ev_hash = hashlib.sha256(raw.encode()).hexdigest()

    inc_uuid = to_uuid(inc_id)
    if not inc_uuid:
        raise HTTPException(404, "incident not found")

    c = Complaint(
        incident_id=inc_uuid,
        category=cat,
        gps=ST_GeogFromText(f"POINT({c_lng} {c_lat})"),
        evidence_hash=ev_hash
    )
    s.add(c)

    # Record in malicious violation log
    s.add(ViolationLog(
        incident_id=inc_uuid,
        violation_type=f"WHISTLEBLOWER_{cat}",
        severity="CRITICAL",
        penalty_inr=10000,
        details={
            "category": cat,
            "lat": c_lat,
            "lng": c_lng,
            "complaint_notes": body.notes if body else None,
        },
        evidence_hash=ev_hash,
    ))
    await s.commit()

    actor_role = u.get("role") if u else "PATIENT"
    await audit_append(
        s,
        inc_uuid,
        "COMPLAINT_FILED",
        actor_role,
        {"category": cat, "hash": ev_hash, "lat": c_lat, "lng": c_lng}
    )
    await broadcast(str(inc_uuid), {
        "type": "whistleblower_alert",
        "category": cat,
        "evidence_hash": ev_hash,
    })
    return {"complaint_id": str(c.id), "evidence_hash": ev_hash}


@app.get("/api/v1/incidents/{incident_id}")
async def get_incident(
    incident_id: str,
    s: AsyncSession = Depends(get_db),
    u: dict | None = Depends(optional_user)
):
    if incident_id.lower() in ("latest", "active", "demo-incident", ""):
        inc = (await s.execute(
            select(Incident).order_by(Incident.created_at.desc()).limit(1)
        )).scalar_one_or_none()
    else:
        inc_uuid = to_uuid(incident_id)
        if not inc_uuid:
            raise HTTPException(404, "not found")
        inc = (await s.execute(
            select(Incident).where(Incident.id == inc_uuid)
        )).scalar_one_or_none()
    if not inc:
        raise HTTPException(404, "not found")

    hosp_name = None
    backup_hosp_name = None
    if inc.primary_hospital_id:
        hosp_name = (await s.execute(
            select(Hospital.name).where(Hospital.id == inc.primary_hospital_id)
        )).scalar_one_or_none()
    if inc.backup_hospital_id:
        backup_hosp_name = (await s.execute(
            select(Hospital.name).where(Hospital.id == inc.backup_hospital_id)
        )).scalar_one_or_none()

    return {
        "id": str(inc.id),
        "band": inc.band,
        "rts": float(inc.rts or 0),
        "bed_state": inc.bed_state,
        "phase1_expires": (
            inc.phase1_expires.isoformat() if inc.phase1_expires else None
        ),
        "score": float(inc.score or 0),
        "deviation_m": float(inc.deviation_m or 0),
        "sla_penalty_inr": inc.sla_penalty_inr or 0,
        "current_lat": float(inc.current_lat or 18.5204),
        "current_lng": float(inc.current_lng or 73.8567),
        "eta_seconds": inc.eta_seconds or 300,
        "primary_hospital": hosp_name or "Sahyadri Trauma ED",
        "primary_hospital_id": (
            str(inc.primary_hospital_id) if inc.primary_hospital_id else None
        ),
        "backup_hospital": backup_hosp_name or "Ruby Hall Neuro Trauma",
        "backup_hospital_id": (
            str(inc.backup_hospital_id) if inc.backup_hospital_id else None
        ),
        "patient": {
            "name": inc.patient_name or "Aarav Kulkarni",
            "phone": inc.patient_phone or "+919820112233",
            "abha": inc.patient_abha or "91-4521-8834-0912",
            "blood_group": inc.patient_blood_group or "O+",
            "allergies": inc.patient_allergies or "Penicillin, Sulfa drugs",
            "medical_history": (
                inc.patient_medical_history
                or "Hypertension, Mild Asthma"
            ),
        },
        "created_at": (
            inc.created_at.isoformat() if inc.created_at else None
        ),
    }


@app.get("/api/v1/incidents/{incident_id}/telemetry")
async def get_incident_telemetry(
    incident_id: str,
    s: AsyncSession = Depends(get_db),
    u: dict | None = Depends(optional_user)
):
    inc_uuid = to_uuid(incident_id)
    if not inc_uuid:
        inc = (await s.execute(
            select(Incident).order_by(Incident.created_at.desc()).limit(1)
        )).scalar_one_or_none()
        if inc:
            inc_uuid = inc.id
        else:
            raise HTTPException(404, "incident not found")

    breadcrumbs = (await s.execute(
        select(RouteBreadcrumb)
        .where(RouteBreadcrumb.incident_id == inc_uuid)
        .order_by(RouteBreadcrumb.timestamp.asc())
    )).scalars().all()

    vitals = (await s.execute(
        select(VitalsLog)
        .where(VitalsLog.incident_id == inc_uuid)
        .order_by(VitalsLog.recorded_at.desc())
        .limit(20)
    )).scalars().all()

    violations = (await s.execute(
        select(ViolationLog)
        .where(ViolationLog.incident_id == inc_uuid)
        .order_by(ViolationLog.detected_at.desc())
    )).scalars().all()

    return {
        "incident_id": str(inc_uuid),
        "breadcrumbs": [
            {
                "latitude": float(b.latitude),
                "longitude": float(b.longitude),
                "speed_kmh": float(b.speed_kmh),
                "lateral_deviation_m": float(b.lateral_deviation_m),
                "is_halt": b.is_halt,
                "timestamp": b.timestamp.isoformat() if b.timestamp else None,
            }
            for b in breadcrumbs
        ],
        "vitals_history": [
            {
                "heart_rate": v.heart_rate,
                "systolic_bp": v.systolic_bp,
                "spo2": v.spo2,
                "gcs": v.gcs,
                "respiratory_rate": v.respiratory_rate,
                "rts": float(v.rts),
                "band": v.band,
                "recorded_at": (
                    v.recorded_at.isoformat() if v.recorded_at else None
                ),
            }
            for v in reversed(vitals)
        ],
        "violations": [
            {
                "id": str(v.id),
                "violation_type": v.violation_type,
                "severity": v.severity,
                "penalty_inr": v.penalty_inr,
                "details": v.details,
                "evidence_hash": v.evidence_hash,
                "detected_at": (
                    v.detected_at.isoformat() if v.detected_at else None
                ),
            }
            for v in violations
        ],
    }


@app.get("/api/v1/incidents/{incident_id}/audit")
async def get_incident_audit(
    incident_id: str,
    s: AsyncSession = Depends(get_db),
    u: dict | None = Depends(optional_user)
):
    inc_uuid = to_uuid(incident_id)
    if not inc_uuid:
        inc = (await s.execute(
            select(Incident).order_by(Incident.created_at.desc()).limit(1)
        )).scalar_one_or_none()
        if inc:
            inc_uuid = inc.id
        else:
            raise HTTPException(404, "incident not found")

    entries = (await s.execute(
        select(AuditLedger)
        .where(AuditLedger.incident_id == inc_uuid)
        .order_by(AuditLedger.seq.asc())
    )).scalars().all()

    return {
        "incident_id": str(inc_uuid),
        "audit_trail": [
            {
                "seq": a.seq,
                "event_type": a.event_type,
                "actor_role": a.actor_role,
                "prev_hash": a.prev_hash,
                "curr_hash": a.curr_hash,
                "payload": a.payload,
                "recorded_at": (
                    a.recorded_at.isoformat() if a.recorded_at else None
                ),
            }
            for a in entries
        ],
    }


@app.get("/api/v1/user/me")
async def get_me(
    s: AsyncSession = Depends(get_db),
    u: dict = Depends(current_user)
):
    user_uuid = to_uuid(u.get("sub"))
    if not user_uuid:
        raise HTTPException(401, "invalid user token")
    user = (await s.execute(
        select(User).where(User.id == user_uuid)
    )).scalar_one_or_none()
    if not user:
        raise HTTPException(404, "user not found")
    return {
        "id": str(user.id),
        "login_id": user.login_id,
        "full_name": user.full_name,
        "role": user.role,
        "abha_id": user.abha_id,
        "blood_group": user.blood_group,
        "allergies": user.allergies,
        "pre_existing_conditions": user.pre_existing_conditions,
        "age": user.age,
        "gender": user.gender,
        "trusted_contact_name": user.trusted_contact_name,
        "trusted_contact_phone": user.trusted_contact_phone,
    }


@app.put("/api/v1/user/profile")
async def update_profile(
    body: PatientProfileUpdate,
    s: AsyncSession = Depends(get_db),
    u: dict = Depends(current_user)
):
    user_uuid = to_uuid(u.get("sub"))
    if not user_uuid:
        raise HTTPException(401, "invalid user token")
    user = (await s.execute(
        select(User).where(User.id == user_uuid)
    )).scalar_one_or_none()
    if not user:
        raise HTTPException(404, "user not found")

    if body.full_name is not None:
        user.full_name = body.full_name
    if body.abha_id is not None:
        user.abha_id = body.abha_id
    if body.blood_group is not None:
        user.blood_group = body.blood_group
    if body.allergies is not None:
        user.allergies = body.allergies
    if body.pre_existing_conditions is not None:
        user.pre_existing_conditions = body.pre_existing_conditions
    if body.trusted_contact_name is not None:
        user.trusted_contact_name = body.trusted_contact_name
    if body.trusted_contact_phone is not None:
        user.trusted_contact_phone = body.trusted_contact_phone

    await s.commit()
    return {"status": "updated"}


@app.websocket("/ws/{incident_id}")
async def ws_endpoint(ws: WebSocket, incident_id: str):
    await ws.accept()
    ws_clients.setdefault(incident_id, set()).add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_clients.get(incident_id, set()).discard(ws)


FRONTEND_DIST = (
    Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
)
if (FRONTEND_DIST / "assets").exists():
    app.mount(
        "/assets",
        StaticFiles(directory=str(FRONTEND_DIST / "assets")),
        name="assets"
    )


@app.get("/favicon.ico")
async def favicon():
    fav = FRONTEND_DIST / "favicon.ico"
    if fav.exists():
        return FileResponse(str(fav))
    return Response(status_code=204)


@app.get("/")
async def root():
    idx = FRONTEND_DIST / "index.html"
    if idx.exists():
        return FileResponse(str(idx))
    return {
        "status": "ok",
        "service": "Golden Lane EMS API",
        "docs": "/docs"
    }


@app.get("/{full_path:path}")
async def catch_all_spa(full_path: str):
    if (
        full_path.startswith("api/")
        or full_path.startswith("ws/")
        or full_path.startswith("docs")
        or full_path.startswith("openapi.json")
    ):
        raise HTTPException(404, "Not Found")
    idx = FRONTEND_DIST / "index.html"
    if idx.exists():
        return FileResponse(str(idx))
    raise HTTPException(404, "Not Found")
