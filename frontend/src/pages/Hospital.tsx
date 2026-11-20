import { useEffect, useState } from 'react';
import type { Session } from '../App';
import {
  apiPhase2,
  apiGetIncident,
  apiGetAudit,
  apiGetTelemetry,
  connectWs,
  type IncidentDetails,
  type AuditRecord,
  type TelemetryResponse,
} from '../api';

export default function Hospital({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [incidentId, setIncidentId] = useState('');
  const [incident, setIncident] = useState<IncidentDetails | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [auditTrail, setAuditTrail] = useState<AuditRecord[]>([]);

  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(targetId?: string) {
    setErr(null); setMsg(null);
    const idToLoad = (targetId || incidentId || 'latest').trim();
    try {
      const data = await apiGetIncident(idToLoad, session.token);
      if (data && data.id) {
        setIncident(data);
        setIncidentId(data.id);
        const telem = await apiGetTelemetry(data.id, session.token);
        if (telem) setTelemetry(telem);
        const audit = await apiGetAudit(data.id, session.token);
        if (audit && audit.audit_trail) setAuditTrail(audit.audit_trail);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load incident');
    }
  }

  useEffect(() => {
    load('latest');
    const interval = setInterval(() => {
      if (incidentId) load(incidentId);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  // Live WebSocket
  useEffect(() => {
    if (!incidentId) return;
    return connectWs(incidentId, (m) => {
      const data = m as { type: string; state?: string; band?: string };
      if (data.type === 'bed_state' && data.state) {
        setIncident(prev => (prev ? { ...prev, bed_state: data.state! } : prev));
      }
      if (data.type === 'vitals' && data.band) {
        setIncident(prev => (prev ? { ...prev, band: data.band! } : prev));
      }
      load(incidentId);
    });
  }, [incidentId]);

  async function confirmHardLock() {
    setErr(null); setMsg(null);
    const idToConfirm = (incidentId || incident?.id || '').trim();
    if (!idToConfirm) {
      setErr('Please provide an incident ID');
      return;
    }
    setBusy(true);
    try {
      await apiPhase2(session.token, idToConfirm);
      setMsg('✓ Phase 2 Hard Lock Confirmed. Trauma Bay ICU-1 has been locked and persisted.');
      await load(idToConfirm);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Hard lock confirmation failed');
    } finally {
      setBusy(false);
    }
  }

  async function testArticle21Diversion() {
    setErr(null); setMsg(null);
    const idToTest = (incidentId || incident?.id || '').trim();
    if (!idToTest) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/bed/decline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ incident_id: idToTest, reason_code: 'FULL_CAPACITY' }),
      });
      if (r.status === 403) {
        const d = await r.json();
        setMsg(`🛡️ ARTICLE 21 ANTI-DIVERSION ACTIVE: ${d.detail}. Critical stabilization cannot be declined.`);
      } else {
        const d = await r.json();
        setMsg(`Status: ${JSON.stringify(d)}`);
      }
      load(idToTest);
    } catch (e) {
      setErr('Diversion request failed.');
    } finally {
      setBusy(false);
    }
  }

  const patientInfo = incident?.patient ?? {
    name: 'Aarav Kulkarni',
    phone: '+919820112233',
    abha: '91-4521-8834-0912',
    blood_group: 'O+',
    allergies: 'Penicillin, Sulfa drugs',
    medical_history: 'Hypertension, Mild Asthma',
  };

  return (
    <div className="container">
      {/* Top Hospital ED Header */}
      <div className="card" style={{ marginBottom: 20, background: 'linear-gradient(90deg, var(--bg-panel) 0%, var(--bg-panel-alt) 100%)', borderLeft: '6px solid var(--accent)' }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="live-pulse" />
              <h2 style={{ fontSize: 20, fontWeight: 800 }}>
                SAHYADRI TRAUMA EMERGENCY DEPARTMENT (HOSP-01)
              </h2>
              <span className="badge badge-accent">LEVEL 1 TRAUMA</span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }} className="mono">
              Chief Triage Station · Golden Lane Anti-Nexus Gateway · HPR: HPR-SAHYADRI-01
            </p>
          </div>
          <div className="row">
            <input
              className="input mono"
              style={{ width: 220, fontSize: 12 }}
              value={incidentId}
              onChange={e => setIncidentId(e.target.value)}
              placeholder="Incident UUID"
            />
            <button className="btn btn-ghost" onClick={() => load()} type="button">
              Load
            </button>
            <button className="btn btn-ghost" onClick={() => load('latest')} type="button">
              Latest
            </button>
          </div>
        </div>
      </div>

      {/* Facility Capacity Telemetry */}
      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <div className="metric-box">
          <div className="metric-lbl">ICU Beds</div>
          <div className="metric-val" style={{ color: 'var(--accent)' }}>14 Beds</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>1 Held in Phase 1</div>
        </div>
        <div className="metric-box">
          <div className="metric-lbl">Trauma Resuscitation Bays</div>
          <div className="metric-val" style={{ color: 'var(--status-stable)' }}>4 Bays</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Bay 1 Prepared</div>
        </div>
        <div className="metric-box">
          <div className="metric-lbl">Cath Lab & Neuro</div>
          <div className="metric-val" style={{ color: 'var(--status-stable)', fontSize: 18 }}>READY</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>On-Call Neurosurgeon Active</div>
        </div>
        <div className="metric-box">
          <div className="metric-lbl">ED Triage Queue</div>
          <div className="metric-val" style={{ color: 'var(--accent)' }}>4 min</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Readiness Index: 0.920</div>
        </div>
      </div>

      {/* Incoming Ambulance & Patient Details */}
      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        {/* Incoming Emergency Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🚨 Incoming Emergency Vehicle</span>
            <span className={`badge badge-${incident?.band === 'CRITICAL' ? 'critical' : 'stable'}`}>
              {incident?.band || 'NO DISPATCH'}
            </span>
          </div>

          {incident ? (
            <div>
              <div className="grid grid-2" style={{ gap: 12, marginBottom: 16 }}>
                <div>
                  <span className="label">Assigned Incident</span>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 'bold', userSelect: 'all' }}>
                    {incident.id}
                  </div>
                </div>
                <div>
                  <span className="label">Bed Reservation State</span>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 'bold', color: incident.bed_state === 'PHASE_2_CONFIRMED' ? 'var(--status-stable)' : 'var(--status-warning)' }}>
                    {incident.bed_state}
                  </div>
                </div>
                <div>
                  <span className="label">Revised Trauma Score (RTS)</span>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 'bold' }}>
                    {incident.rts} ({incident.band})
                  </div>
                </div>
                <div>
                  <span className="label">Corridor Deviation / SLA</span>
                  <div className="mono" style={{ fontSize: 13, color: incident.deviation_m > 250 ? 'var(--status-critical)' : 'var(--status-stable)' }}>
                    {incident.deviation_m.toFixed(1)} m · Fine: ₹{incident.sla_penalty_inr}
                  </div>
                </div>
              </div>

              <div className="row" style={{ gap: 10 }}>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={confirmHardLock}
                  disabled={busy || incident.bed_state === 'PHASE_2_CONFIRMED'}
                >
                  {incident.bed_state === 'PHASE_2_CONFIRMED'
                    ? '✓ Phase 2 Hard Lock Active'
                    : '🔒 Confirm Phase 2 Bed Hard Lock'}
                </button>

                <button
                  className="btn btn-ghost"
                  style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
                  onClick={testArticle21Diversion}
                  disabled={busy}
                  title="Test anti-diversion legal protection"
                >
                  Test Decline (Article 21)
                </button>
              </div>

              {msg && <p style={{ color: 'var(--status-stable)', marginTop: 12, fontSize: 13 }} className="mono">{msg}</p>}
              {err && <p style={{ color: 'var(--status-critical)', marginTop: 12, fontSize: 13 }} className="mono">{err}</p>}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)' }}>
              No active inbound emergency allocated. Click "Latest" or trigger SOS.
            </div>
          )}
        </div>

        {/* Patient Clinical Dossier Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🩸 Inbound Patient Medical Profile</span>
            <span className="badge badge-accent">PRE-ARRIVAL DOSSIER</span>
          </div>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <div>
              <span className="label">Patient Name</span>
              <div className="mono" style={{ fontSize: 14, fontWeight: 'bold' }}>{patientInfo.name}</div>
            </div>
            <div>
              <span className="label">Ayushman ABHA ID</span>
              <div className="mono" style={{ fontSize: 13, color: 'var(--accent)' }}>{patientInfo.abha}</div>
            </div>
            <div>
              <span className="label">Blood Group</span>
              <div className="mono" style={{ fontSize: 15, fontWeight: 'bold', color: 'var(--status-critical)' }}>
                🩸 {patientInfo.blood_group} (Confirm crossmatch)
              </div>
            </div>
            <div>
              <span className="label">Emergency Contact</span>
              <div className="mono" style={{ fontSize: 13 }}>Sunita Kulkarni · +919820998877</div>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <span className="label">Drug Allergies Alert</span>
              <div className="mono" style={{ fontSize: 13, color: 'var(--status-critical)', fontWeight: 'bold' }}>
                ⚠️ {patientInfo.allergies}
              </div>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <span className="label">Chronic Medical History</span>
              <div className="mono" style={{ fontSize: 13 }}>{patientInfo.medical_history}</div>
            </div>
          </div>

          <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span className="label">Pre-Arrival Action Items</span>
            <ul style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              <li>Held Trauma Bay 1 under Golden Lane Anti-Nexus lock</li>
              <li>2 units O+ uncrossmatched blood set aside at blood bank</li>
              <li>Scan EMT QR code upon bay arrival to complete handover</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Live Vitals Telemetry History Table */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">📊 Streaming Vital Signs Log (Recorded in Transit)</span>
          <span className="badge badge-accent">TELEMETRY STREAM</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Heart Rate</th>
              <th>Blood Pressure (SBP)</th>
              <th>SpO2</th>
              <th>GCS Score</th>
              <th>Resp Rate</th>
              <th>RTS</th>
              <th>Triage Band</th>
              <th>Recorded Time</th>
            </tr>
          </thead>
          <tbody>
            {!telemetry || telemetry.vitals_history.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  Awaiting vital signs telemetry from ambulance crew…
                </td>
              </tr>
            ) : (
              telemetry.vitals_history.map((v, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 'bold' }}>{v.heart_rate} bpm</td>
                  <td>{v.systolic_bp} mmHg</td>
                  <td>{v.spo2} %</td>
                  <td>{v.gcs} / 15</td>
                  <td>{v.respiratory_rate} /min</td>
                  <td className="mono" style={{ fontWeight: 'bold' }}>{v.rts}</td>
                  <td>
                    <span className={`badge badge-${v.band === 'CRITICAL' ? 'critical' : v.band === 'WARNING' ? 'warning' : 'stable'}`}>
                      {v.band}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {v.recorded_at ? new Date(v.recorded_at).toLocaleTimeString() : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Tamper-Proof Cryptographic Audit Ledger */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">⛓️ NHM Audit Trail (SHA-256 Hash Chained)</span>
          <span className="badge badge-stable">LEGAL COMPLIANT</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Seq #</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Previous Hash</th>
              <th>Current Hash (SHA-256)</th>
              <th>Recorded At</th>
            </tr>
          </thead>
          <tbody>
            {auditTrail.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  Loading immutable audit entries…
                </td>
              </tr>
            ) : (
              auditTrail.map(a => (
                <tr key={a.seq}>
                  <td style={{ fontWeight: 'bold' }}>#{a.seq}</td>
                  <td><span className="badge badge-accent">{a.event_type}</span></td>
                  <td>{a.actor_role}</td>
                  <td title={a.prev_hash}>{a.prev_hash.slice(0, 14)}…</td>
                  <td title={a.curr_hash} style={{ color: 'var(--accent)', fontWeight: 'bold' }}>
                    {a.curr_hash.slice(0, 14)}…
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {a.recorded_at ? new Date(a.recorded_at).toLocaleTimeString() : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
