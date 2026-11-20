import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
import bcrypt
from jose import jwt
from sqlalchemy import select, text, func
from sqlalchemy.ext.asyncio import AsyncSession
from geoalchemy2.functions import ST_GeogFromText
from .config import settings
from .models import AuditLedger, User, Hospital, Ambulance


def hash_password(p: str) -> str:
    return bcrypt.hashpw(p.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(p: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(p.encode("utf-8"), h.encode("utf-8"))
    except Exception:
        return False


def issue_token(user_id: str, role: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(
        minutes=settings.jwt_expire_minutes
    )
    return jwt.encode(
        {"sub": user_id, "role": role, "exp": exp},
        settings.jwt_secret,
        algorithm=settings.jwt_alg
    )


def decode_token(token: str) -> dict:
    return jwt.decode(
        token, settings.jwt_secret, algorithms=[settings.jwt_alg]
    )


def to_uuid(val: str | uuid.UUID | None) -> uuid.UUID | None:
    if val is None:
        return None
    if isinstance(val, uuid.UUID):
        return val
    try:
        return uuid.UUID(str(val).strip())
    except (ValueError, TypeError, AttributeError):
        return None


def rts_and_band(gcs: int, sbp: int, rr: int) -> dict:
    cgcs = (
        4 if gcs >= 13 else 3 if gcs >= 9
        else 2 if gcs >= 6 else 1 if gcs >= 4 else 0
    )
    csbp = (
        4 if sbp > 89 else 3 if sbp >= 76
        else 2 if sbp >= 50 else 1 if sbp >= 1 else 0
    )
    crr = (
        4 if 10 <= rr <= 29 else 3 if rr > 29
        else 2 if 6 <= rr <= 9 else 1 if 1 <= rr <= 5 else 0
    )
    rts = round(0.9368 * cgcs + 0.7326 * csbp + 0.2908 * crr, 4)
    if rts < 4.0 or csbp <= 1 or cgcs <= 1:
        band = "CRITICAL"
    elif rts < 6.0:
        band = "WARNING"
    else:
        band = "STABLE"
    return {"rts": rts, "band": band}


W_TIME, W_READY, W_SURV = 0.40, 0.25, 0.35


def hospital_score(
    transit_min: float, ed_queue_min: float, readiness: float,
    route_risk: float, rts: float, band: str
) -> dict:
    etdc = transit_min * (1.0 + 0.5 * route_risk) + ed_queue_min
    time_eff = max(0.0, 1.0 - (etdc / 60.0))
    decay = (
        0.09 if band == "CRITICAL" else 0.035 if band == "WARNING" else 0.015
    )
    surv = max(0.05, min(0.99, (rts / 7.8408) * (1.0 - decay * (etdc / 10.0))))
    score = round(W_TIME * time_eff + W_READY * readiness + W_SURV * surv, 4)
    return {"etdc_minutes": round(etdc, 2), "score": score}


async def audit_append(
    session: AsyncSession,
    incident_id: str | uuid.UUID,
    event_type: str,
    actor_role: str,
    payload: dict
) -> None:
    # Serialize all appends so prev_hash chain is never forked (Postgres lock)
    try:
        await session.execute(
            text(
                "SELECT pg_advisory_xact_lock("
                "hashtext('audit_ledger_chain'))"
            )
        )
    except Exception:
        pass
    last = (await session.execute(
        select(AuditLedger).order_by(AuditLedger.seq.desc()).limit(1)
    )).scalar_one_or_none()
    prev = last.curr_hash if last else "0" * 64
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    raw_hash = (
        f"{prev}|{str(incident_id)}|{event_type}|{actor_role}|{serialized}"
    )
    curr = hashlib.sha256(raw_hash.encode()).hexdigest()
    inc_uuid = to_uuid(incident_id) or uuid.uuid4()
    session.add(AuditLedger(
        incident_id=inc_uuid, event_type=event_type,
        actor_role=actor_role, payload=payload,
        prev_hash=prev, curr_hash=curr,
    ))
    await session.commit()


async def seed_if_empty(session: AsyncSession) -> None:
    n = await session.scalar(select(func.count()).select_from(User))
    if n and n > 0:
        return

    # Seed capable hospitals
    hosp1 = Hospital(
        hpr_id="HOSP-01",
        name="Sahyadri Trauma ED",
        location=ST_GeogFromText("POINT(73.8567 18.5204)"),
        is_government=False,
        icu_beds=14,
        trauma_bays=4,
        has_cath_lab=True,
        has_neurosurgery=True,
        has_pediatric=True,
        ed_queue_minutes=4,
        readiness=0.920,
    )
    hosp2 = Hospital(
        hpr_id="HOSP-02",
        name="Ruby Hall Neuro Trauma",
        location=ST_GeogFromText("POINT(73.8777 18.5314)"),
        is_government=False,
        icu_beds=8,
        trauma_bays=2,
        has_cath_lab=True,
        has_neurosurgery=True,
        has_pediatric=False,
        ed_queue_minutes=8,
        readiness=0.860,
    )
    hosp3 = Hospital(
        hpr_id="HOSP-03",
        name="KEM Memorial General Hospital",
        location=ST_GeogFromText("POINT(73.8688 18.5246)"),
        is_government=True,
        icu_beds=10,
        trauma_bays=3,
        has_cath_lab=False,
        has_neurosurgery=True,
        has_pediatric=True,
        ed_queue_minutes=6,
        readiness=0.880,
    )
    session.add_all([hosp1, hosp2, hosp3])

    # Seed ambulance
    amb = Ambulance(
        registration="MH-12-EM-1084",
        ais_class="TYPE_D",
        driver_name="Ramesh Shinde",
        driver_phone="+919822001122",
        emt_name="EMT Priya Nair",
        equipment_ok=True,
        location=ST_GeogFromText("POINT(73.8567 18.5204)"),
        available=True,
    )
    session.add(amb)
    await session.flush()

    demo = [
        ("9820112233", "Aarav Kulkarni", "PATIENT", None),
        ("AMB-108",    "EMT Priya Nair", "AMBULANCE_EMT", amb.id),
        ("HOSP-01",    "Sahyadri Trauma ED", "HOSPITAL_ED", hosp1.id),
    ]
    for login_id, name, role, entity_ref in demo:
        u = User(
            login_id=login_id,
            full_name=name,
            role=role,
            entity_ref=entity_ref,
            password_hash=hash_password("demo1234"),
        )
        if role == "PATIENT":
            u.abha_id = "91-4521-8834-0912"
            u.trusted_contact_name = "Sunita Kulkarni (Wife)"
            u.trusted_contact_phone = "+919820998877"
            u.blood_group = "O+"
            u.allergies = "Penicillin, Sulfa drugs"
            u.pre_existing_conditions = "Hypertension, Mild Asthma"
            u.age = 42
            u.gender = "M"
        session.add(u)
    await session.commit()
