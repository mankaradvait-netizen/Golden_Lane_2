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
  patient_name VARCHAR(120),
  patient_phone VARCHAR(20),
  patient_abha VARCHAR(32),
  patient_blood_group VARCHAR(8),
  patient_allergies VARCHAR(255),
  patient_medical_history VARCHAR(255),
  current_lat NUMERIC(9,6),
  current_lng NUMERIC(9,6),
  eta_seconds INT DEFAULT 300,
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

CREATE TABLE route_breadcrumbs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  latitude NUMERIC(9,6) NOT NULL,
  longitude NUMERIC(9,6) NOT NULL,
  speed_kmh NUMERIC(5,2) NOT NULL DEFAULT 45.0,
  lateral_deviation_m NUMERIC(8,2) NOT NULL DEFAULT 0.0,
  is_halt BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX route_breadcrumbs_inc_idx ON route_breadcrumbs(incident_id);

CREATE TABLE violation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  violation_type VARCHAR(64) NOT NULL,
  severity VARCHAR(24) NOT NULL DEFAULT 'HIGH',
  penalty_inr INT NOT NULL DEFAULT 0,
  details JSONB NOT NULL,
  evidence_hash CHAR(64) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX violation_logs_inc_idx ON violation_logs(incident_id);

CREATE TABLE vitals_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  heart_rate INT NOT NULL,
  systolic_bp INT NOT NULL,
  spo2 INT NOT NULL,
  gcs INT NOT NULL,
  respiratory_rate INT NOT NULL,
  rts NUMERIC(6,4) NOT NULL,
  band VARCHAR(24) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX vitals_logs_inc_idx ON vitals_logs(incident_id);
