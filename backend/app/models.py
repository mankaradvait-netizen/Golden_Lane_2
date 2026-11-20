import uuid
from datetime import datetime
# pyrefly: ignore[missing-import]
from sqlalchemy import (
    String,
    Integer,
    Boolean,
    Numeric,
    ForeignKey,
    DateTime,
    func,
)
# pyrefly: ignore[missing-import]
from sqlalchemy.dialects.postgresql import UUID, JSONB, ENUM as PGEnum
# pyrefly: ignore[missing-import]
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
# pyrefly: ignore[missing-import]
from sqlalchemy.ext.compiler import compiles
# pyrefly: ignore[missing-import]
from geoalchemy2 import Geography


@compiles(Geography, "sqlite")
def compile_geography_sqlite(type_, compiler, **kw):
    return "TEXT"


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    login_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String)
    full_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(
        PGEnum(
            "PATIENT",
            "AMBULANCE_EMT",
            "HOSPITAL_ED",
            "NHM_AUDITOR",
            name="user_role"
        )
    )
    abha_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    trusted_contact_name: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )
    trusted_contact_phone: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )
    blood_group: Mapped[str | None] = mapped_column(String(8), nullable=True)
    allergies: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pre_existing_conditions: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gender: Mapped[str | None] = mapped_column(String(16), nullable=True)
    entity_ref: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Hospital(Base):
    __tablename__ = "hospitals"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    hpr_id: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    location = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False)
    )
    is_government: Mapped[bool] = mapped_column(Boolean, default=False)
    icu_beds: Mapped[int] = mapped_column(Integer, default=0)
    trauma_bays: Mapped[int] = mapped_column(Integer, default=0)
    has_cath_lab: Mapped[bool] = mapped_column(Boolean, default=False)
    has_neurosurgery: Mapped[bool] = mapped_column(Boolean, default=False)
    has_pediatric: Mapped[bool] = mapped_column(Boolean, default=False)
    ed_queue_minutes: Mapped[int] = mapped_column(Integer, default=5)
    readiness: Mapped[float] = mapped_column(Numeric(4, 3), default=0.85)
    diversion_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Ambulance(Base):
    __tablename__ = "ambulances"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    registration: Mapped[str] = mapped_column(String(24), unique=True)
    ais_class: Mapped[str] = mapped_column(
        PGEnum("TYPE_A", "TYPE_B", "TYPE_C", "TYPE_D", name="ais_class")
    )
    driver_name: Mapped[str] = mapped_column(String(120))
    driver_phone: Mapped[str] = mapped_column(String(20))
    emt_name: Mapped[str] = mapped_column(String(120))
    equipment_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    location = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False),
        nullable=True
    )
    available: Mapped[bool] = mapped_column(Boolean, default=True)


class Incident(Base):
    __tablename__ = "incidents"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    patient_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    ambulance_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ambulances.id"), nullable=True
    )
    primary_hospital_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True
    )
    backup_hospital_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True
    )
    pickup = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False)
    )
    corridor = mapped_column(
        Geography(geometry_type="POLYGON", srid=4326, spatial_index=False),
        nullable=True
    )
    rts: Mapped[float | None] = mapped_column(Numeric(6, 4), nullable=True)
    band: Mapped[str] = mapped_column(String(24), default="CRITICAL")
    score: Mapped[float | None] = mapped_column(Numeric(6, 4), nullable=True)
    bed_state: Mapped[str] = mapped_column(
        PGEnum(
            "UNASSIGNED",
            "PHASE_1_RESERVED",
            "PHASE_2_CONFIRMED",
            "DIVERTED",
            "HANDOVER_COMPLETE",
            name="bed_state"
        ),
        default="UNASSIGNED"
    )
    phase1_expires: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deviation_m: Mapped[float] = mapped_column(Numeric(8, 2), default=0)
    sla_penalty_inr: Mapped[int] = mapped_column(Integer, default=0)
    patient_name: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )
    patient_phone: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )
    patient_abha: Mapped[str | None] = mapped_column(String(32), nullable=True)
    patient_blood_group: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    patient_allergies: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    patient_medical_history: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    current_lat: Mapped[float | None] = mapped_column(
        Numeric(9, 6), nullable=True
    )
    current_lng: Mapped[float | None] = mapped_column(
        Numeric(9, 6), nullable=True
    )
    eta_seconds: Mapped[int | None] = mapped_column(Integer, default=300)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AuditLedger(Base):
    __tablename__ = "audit_ledger"
    seq: Mapped[int] = mapped_column(
        Integer, primary_key=True, autoincrement=True
    )
    incident_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    event_type: Mapped[str] = mapped_column(String(64))
    actor_role: Mapped[str] = mapped_column(
        PGEnum(
            "PATIENT",
            "AMBULANCE_EMT",
            "HOSPITAL_ED",
            "NHM_AUDITOR",
            name="user_role"
        )
    )
    payload: Mapped[dict] = mapped_column(JSONB)
    prev_hash: Mapped[str] = mapped_column(String(64))
    curr_hash: Mapped[str] = mapped_column(String(64))
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Complaint(Base):
    __tablename__ = "complaints"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("incidents.id"))
    reporter_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    category: Mapped[str] = mapped_column(String(64))
    audio_uri: Mapped[str | None] = mapped_column(String, nullable=True)
    gps = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False)
    )
    evidence_hash: Mapped[str] = mapped_column(String(64))


class RouteBreadcrumb(Base):
    __tablename__ = "route_breadcrumbs"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id"), index=True
    )
    latitude: Mapped[float] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float] = mapped_column(Numeric(9, 6))
    speed_kmh: Mapped[float] = mapped_column(Numeric(5, 2), default=45.0)
    lateral_deviation_m: Mapped[float] = mapped_column(
        Numeric(8, 2), default=0.0
    )
    is_halt: Mapped[bool] = mapped_column(Boolean, default=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ViolationLog(Base):
    __tablename__ = "violation_logs"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id"), index=True
    )
    violation_type: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(24), default="HIGH")
    penalty_inr: Mapped[int] = mapped_column(Integer, default=0)
    details: Mapped[dict] = mapped_column(JSONB)
    evidence_hash: Mapped[str] = mapped_column(String(64))
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class VitalsLog(Base):
    __tablename__ = "vitals_logs"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id"), index=True
    )
    heart_rate: Mapped[int] = mapped_column(Integer)
    systolic_bp: Mapped[int] = mapped_column(Integer)
    spo2: Mapped[int] = mapped_column(Integer)
    gcs: Mapped[int] = mapped_column(Integer)
    respiratory_rate: Mapped[int] = mapped_column(Integer)
    rts: Mapped[float] = mapped_column(Numeric(6, 4))
    band: Mapped[str] = mapped_column(String(24))
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
