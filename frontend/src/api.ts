export interface PatientData {
  name: string;
  phone: string;
  abha: string;
  blood_group: string;
  allergies: string;
  medical_history: string;
}

export interface Breadcrumb {
  latitude: number;
  longitude: number;
  speed_kmh: number;
  lateral_deviation_m: number;
  is_halt: boolean;
  timestamp: string | null;
}

export interface VitalsRecord {
  heart_rate: number;
  systolic_bp: number;
  spo2: number;
  gcs: number;
  respiratory_rate: number;
  rts: number;
  band: string;
  recorded_at: string | null;
}

export interface ViolationRecord {
  id: string;
  violation_type: string;
  severity: string;
  penalty_inr: number;
  details: Record<string, unknown>;
  evidence_hash: string;
  detected_at: string | null;
}

export interface AuditRecord {
  seq: number;
  event_type: string;
  actor_role: string;
  prev_hash: string;
  curr_hash: string;
  payload: Record<string, unknown>;
  recorded_at: string | null;
}

export interface TelemetryResponse {
  incident_id: string;
  breadcrumbs: Breadcrumb[];
  vitals_history: VitalsRecord[];
  violations: ViolationRecord[];
}

export interface AuditResponse {
  incident_id: string;
  audit_trail: AuditRecord[];
}

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
  token?: string;
  patient?: PatientData;
}

export interface IncidentDetails {
  id: string;
  band: string;
  rts: number;
  bed_state: string;
  phase1_expires: string | null;
  score: number;
  deviation_m: number;
  sla_penalty_inr: number;
  current_lat: number;
  current_lng: number;
  eta_seconds: number;
  primary_hospital: string;
  primary_hospital_id: string | null;
  backup_hospital: string;
  backup_hospital_id: string | null;
  patient?: PatientData;
  created_at: string | null;
}

const BASE = '';

export async function apiLogin(login_id: string, password: string): Promise<LoginResponse> {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id, password }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error((data.detail as string) ?? 'login failed');
  }
  return r.json() as Promise<LoginResponse>;
}

export async function apiSos(
  lat: number,
  lng: number,
  extra?: Partial<PatientData>
): Promise<SosResponse> {
  const r = await fetch(`${BASE}/api/v1/sos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat,
      lng,
      device_note: 'browser_sos',
      patient_name: extra?.name,
      patient_phone: extra?.phone,
      abha_id: extra?.abha,
      blood_group: extra?.blood_group,
      allergies: extra?.allergies,
      pre_existing_conditions: extra?.medical_history,
    }),
  });
  if (!r.ok) throw new Error('sos failed');
  return r.json() as Promise<SosResponse>;
}

export async function apiGetIncident(id: string, token?: string): Promise<IncidentDetails> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const r = await fetch(`${BASE}/api/v1/incidents/${id}`, { headers });
  if (!r.ok) throw new Error('fetch failed');
  return r.json() as Promise<IncidentDetails>;
}

export async function apiGetTelemetry(id: string, token?: string): Promise<TelemetryResponse> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const r = await fetch(`${BASE}/api/v1/incidents/${id}/telemetry`, { headers });
  if (!r.ok) throw new Error('fetch telemetry failed');
  return r.json() as Promise<TelemetryResponse>;
}

export async function apiGetAudit(id: string, token?: string): Promise<AuditResponse> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const r = await fetch(`${BASE}/api/v1/incidents/${id}/audit`, { headers });
  if (!r.ok) throw new Error('fetch audit failed');
  return r.json() as Promise<AuditResponse>;
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
  incident_id: string;
  lateral_deviation_m: number;
  unscheduled_halt_s: number;
  delayed_minutes: number;
  latitude?: number;
  longitude?: number;
  speed_kmh?: number;
}): Promise<{
  violation: boolean;
  violations?: string[];
  sla_penalty_inr: number;
  total_penalty_added?: number;
}> {
  const r = await fetch(`${BASE}/api/v1/telemetry/corridor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('corridor failed');
  return r.json() as Promise<{
    violation: boolean;
    violations?: string[];
    sla_penalty_inr: number;
    total_penalty_added?: number;
  }>;
}

export async function apiPhase2(token: string, incident_id: string): Promise<{ state: string }> {
  const r = await fetch(`${BASE}/api/v1/bed/phase2?incident_id=${encodeURIComponent(incident_id)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('phase2 failed');
  return r.json() as Promise<{ state: string }>;
}

export async function apiFileComplaint(body: {
  incident_id: string;
  category: string;
  notes?: string;
  lat?: number;
  lng?: number;
}, token?: string): Promise<{ complaint_id: string; evidence_hash: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api/v1/complaints`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('complaint submission failed');
  return r.json() as Promise<{ complaint_id: string; evidence_hash: string }>;
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
