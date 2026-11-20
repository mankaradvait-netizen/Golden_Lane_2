from typing import Literal
# pyrefly: ignore[missing-import]
from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    login_id: str
    password: str


class LoginResponse(BaseModel):
    token: str
    role: Literal["PATIENT", "AMBULANCE_EMT", "HOSPITAL_ED"]
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
    patient_name: str | None = None
    patient_phone: str | None = None
    abha_id: str | None = None
    blood_group: str | None = None
    allergies: str | None = None
    pre_existing_conditions: str | None = None


class CorridorIn(BaseModel):
    incident_id: str
    lateral_deviation_m: float
    unscheduled_halt_s: int
    delayed_minutes: int
    latitude: float | None = None
    longitude: float | None = None
    speed_kmh: float = 45.0


class BedDeclineIn(BaseModel):
    incident_id: str
    reason_code: str


class PatientProfileUpdate(BaseModel):
    full_name: str | None = None
    abha_id: str | None = None
    blood_group: str | None = None
    allergies: str | None = None
    pre_existing_conditions: str | None = None
    trusted_contact_name: str | None = None
    trusted_contact_phone: str | None = None


class ComplaintIn(BaseModel):
    incident_id: str
    category: str
    audio_uri: str | None = None
    lat: float = 18.5204
    lng: float = 73.8567
    notes: str | None = None
