import { useEffect, useState } from 'react';
import type { Session } from '../App';
import {
  apiPushVitals,
  apiCorridor,
  apiGetIncident,
  apiGetTelemetry,
  connectWs,
  type IncidentDetails,
  type TelemetryResponse,
} from '../api';

export default function Emt({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [incidentId, setIncidentId] = useState('');
  const [incident, setIncident] = useState<IncidentDetails | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);

  // Vitals State
  const [hr, setHr] = useState(115);
  const [sbp, setSbp] = useState(85);
  const [spo2, setSpo2] = useState(93);
  const [gcs, setGcs] = useState(12);
  const [rr, setRr] = useState(22);
  const [rts, setRts] = useState<number | null>(5.48);
  const [band, setBand] = useState('WARNING');

  // Corridor Telemetry State
  const [devM, setDevM] = useState(45);
  const [haltS, setHaltS] = useState(0);
  const [speed, setSpeed] = useState(52);
  const [delayedMin, setDelayedMin] = useState(0);
  const [corridorAlert, setCorridorAlert] = useState<{
    violation: boolean;
    violations?: string[];
    sla_penalty_inr: number;
    total_penalty_added?: number;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Compute live RTS in UI before submit
  useEffect(() => {
    const cgcs = gcs >= 13 ? 4 : gcs >= 9 ? 3 : gcs >= 6 ? 2 : gcs >= 4 ? 1 : 0;
    const csbp = sbp > 89 ? 4 : sbp >= 76 ? 3 : sbp >= 50 ? 2 : sbp >= 1 ? 1 : 0;
    const crr = rr >= 10 && rr <= 29 ? 4 : rr > 29 ? 3 : rr >= 6 ? 2 : rr >= 1 ? 1 : 0;
    const computedRts = Number((0.9368 * cgcs + 0.7326 * csbp + 0.2908 * crr).toFixed(4));
    setRts(computedRts);
    if (computedRts < 4.0 || csbp <= 1 || cgcs <= 1) {
      setBand('CRITICAL');
    } else if (computedRts < 6.0) {
      setBand('WARNING');
    } else {
      setBand('STABLE');
    }
  }, [gcs, sbp, rr]);

  async function load(targetId?: string) {
    setErr(null);
    const idToLoad = (targetId || incidentId || 'latest').trim();
    try {
      const data = await apiGetIncident(idToLoad, session.token);
      if (data && data.id) {
        setIncident(data);
        setIncidentId(data.id);
        const telem = await apiGetTelemetry(data.id, session.token);
        if (telem) setTelemetry(telem);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load incident');
    }
  }

  useEffect(() => {
    load('latest');
  }, []);

  // Live WebSocket
  useEffect(() => {
    if (!incidentId) return;
    return connectWs(incidentId, (m) => {
      const data = m as { type: string; state?: string };
      if (data.type === 'bed_state' && data.state && incident) {
        setIncident(prev => (prev ? { ...prev, bed_state: data.state! } : prev));
      }
      load(incidentId);
    });
  }, [incidentId]);

  async function pushVitals() {
    setErr(null); setMsg(null);
    const targetId = incidentId.trim();
    if (!targetId) {
      setErr('Please load or provide an incident ID first');
      return;
    }
    setBusy(true);
    try {
      const r = await apiPushVitals(session.token, {
        incident_id: targetId,
        heart_rate: hr,
        systolic_bp: sbp,
        spo2,
        gcs,
        respiratory_rate: rr,
      });
      setMsg(`Vitals broadcasted successfully: RTS ${r.rts} (${r.band})`);
      load(targetId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Vitals push failed');
    } finally {
      setBusy(false);
    }
  }

  async function sendCorridorTelemetry() {
    setErr(null); setMsg(null);
    const targetId = incidentId.trim();
    if (!targetId) {
      setErr('Please load or provide an incident ID first');
      return;
    }
    setBusy(true);
    try {
      const r = await apiCorridor(session.token, {
        incident_id: targetId,
        lateral_deviation_m: devM,
        unscheduled_halt_s: haltS,
        delayed_minutes: delayedMin,
        latitude: 18.5240,
        longitude: 73.8610,
        speed_kmh: speed,
      });
      setCorridorAlert(r);
      if (r.violation) {
        setMsg(`⚠️ Malicious act recorded: ${(r.violations || []).join(', ')}. Fine: ₹${r.total_penalty_added} added.`);
      } else {
        setMsg(`✓ In corridor bounds (${devM}m). SLA clean.`);
      }
      load(targetId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Corridor telemetry failed');
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(type: 'SHOCK' | 'WARNING' | 'NORMAL') {
    if (type === 'SHOCK') {
      setHr(138); setSbp(62); setSpo2(89); setGcs(8); setRr(34);
    } else if (type === 'WARNING') {
      setHr(112); setSbp(88); setSpo2(94); setGcs(12); setRr(24);
    } else {
      setHr(76); setSbp(122); setSpo2(99); setGcs(15); setRr(16);
    }
  }

  return (
    <div className="container">
      {/* Top Cockpit Header */}
      <div className="card" style={{ marginBottom: 20, background: '#0F172A', color: '#F8FAFC', border: '1px solid #334155' }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="live-pulse" />
              <h2 style={{ fontSize: 18, color: '#38BDF8', letterSpacing: '0.04em' }}>
                TACTICAL EMS COCKPIT · AMBULANCE UNIT MH-12-EM-1084
              </h2>
              <span className="badge badge-accent">TYPE-D ALS</span>
            </div>
            <p style={{ color: '#94A3B8', fontSize: 12, margin: 0 }} className="mono">
              Driver: Ramesh Shinde (+919822001122) · EMT: Priya Nair · AIS-125 Spec Certified
            </p>
          </div>
          <div className="row">
            <input
              className="input mono"
              style={{ width: 220, fontSize: 12 }}
              value={incidentId}
              onChange={e => setIncidentId(e.target.value)}
              placeholder="Incident ID"
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

      {incident && (
        <div className="grid grid-3" style={{ marginBottom: 20 }}>
          <div className="metric-box">
            <div className="metric-lbl">Destination ED</div>
            <div className="metric-val" style={{ fontSize: 17, color: 'var(--accent)' }}>
              {incident.primary_hospital}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Bed Lock: <strong style={{ color: 'var(--status-stable)' }}>{incident.bed_state}</strong>
            </div>
          </div>
          <div className="metric-box">
            <div className="metric-lbl">Triage Clinical Band</div>
            <div className="metric-val">
              <span className={`badge badge-${incident.band === 'CRITICAL' ? 'critical' : incident.band === 'WARNING' ? 'warning' : 'stable'}`} style={{ fontSize: 16 }}>
                {incident.band}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              RTS Score: <strong>{incident.rts}</strong>
            </div>
          </div>
          <div className="metric-box">
            <div className="metric-lbl">Accumulated SLA Penalty</div>
            <div className="metric-val" style={{ color: incident.sla_penalty_inr > 0 ? 'var(--status-critical)' : 'var(--status-stable)' }}>
              ₹{incident.sla_penalty_inr}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Lateral Dev: <strong>{incident.deviation_m.toFixed(1)} m</strong>
            </div>
          </div>
        </div>
      )}

      {/* Main Grid: Vitals Telemetry + Anti-Nexus Guard */}
      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        {/* Vitals Telemetry Console */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🩺 Real-Time Patient Vitals Monitor</span>
            <div className="row">
              <span className="badge badge-accent">RTS: {rts}</span>
              <span className={`badge badge-${band === 'CRITICAL' ? 'critical' : band === 'WARNING' ? 'warning' : 'stable'}`}>
                {band}
              </span>
            </div>
          </div>

          <div className="row" style={{ marginBottom: 16, gap: 8 }}>
            <span className="label" style={{ margin: 0 }}>Presets:</span>
            <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => applyPreset('SHOCK')} type="button">
              🔴 Severe Shock
            </button>
            <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => applyPreset('WARNING')} type="button">
              🟡 Borderline
            </button>
            <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => applyPreset('NORMAL')} type="button">
              🟢 Stabilized
            </button>
          </div>

          <div className="grid grid-2" style={{ gap: 14 }}>
            <div>
              <label className="label">Heart Rate: <strong>{hr} bpm</strong></label>
              <input type="range" min="30" max="220" value={hr} onChange={e => setHr(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="label">Systolic BP: <strong>{sbp} mmHg</strong></label>
              <input type="range" min="30" max="240" value={sbp} onChange={e => setSbp(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="label">Blood SpO2: <strong>{spo2} %</strong></label>
              <input type="range" min="60" max="100" value={spo2} onChange={e => setSpo2(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="label">Glasgow Coma (GCS): <strong>{gcs} / 15</strong></label>
              <input type="range" min="3" max="15" value={gcs} onChange={e => setGcs(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label className="label">Respiratory Rate: <strong>{rr} breaths/min</strong></label>
              <input type="range" min="5" max="60" value={rr} onChange={e => setRr(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
          </div>

          <button className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} onClick={pushVitals} disabled={busy || !incidentId}>
            📡 Stream Patient Vitals to Hospital & Patient
          </button>
        </div>

        {/* Anti-Nexus Corridor & Malicious Act Guard */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🚨 Anti-Nexus Route & Corridor Guard</span>
            <span className="badge badge-critical">GEO-FENCE</span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
            Simulate or report vehicle deviation and unscheduled halts. Exceeding 250 m or 120 s triggers an automatic malicious act penalty and immutable audit record.
          </p>

          <div style={{ marginBottom: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="label">Lateral Deviation (Threshold: 250m)</label>
              <span className="mono" style={{ fontSize: 13, fontWeight: 'bold', color: devM > 250 ? 'var(--status-critical)' : 'var(--status-stable)' }}>
                {devM} meters {devM > 250 && '⚠️ BREACH'}
              </span>
            </div>
            <input type="range" min="0" max="500" value={devM} onChange={e => setDevM(Number(e.target.value))} style={{ width: '100%' }} />
            <div className="corridor-bar" style={{ marginTop: 6 }}>
              <div className="corridor-safe-zone" title="Legal Corridor (+/-250m)" />
              <div
                className="corridor-pin"
                style={{
                  left: `${Math.min(95, Math.max(5, 50 + (devM / 500) * 45))}%`,
                  background: devM > 250 ? 'var(--status-critical)' : 'var(--status-stable)',
                }}
              />
            </div>
          </div>

          <div className="grid grid-2" style={{ gap: 14, marginBottom: 14 }}>
            <div>
              <label className="label">Unscheduled Halt: <strong>{haltS}s</strong></label>
              <input type="range" min="0" max="300" step="10" value={haltS} onChange={e => setHaltS(Number(e.target.value))} style={{ width: '100%' }} />
              <span style={{ fontSize: 10, color: haltS > 120 ? 'var(--status-critical)' : 'var(--text-muted)' }}>
                {haltS > 120 ? '⚠️ Violation (>120s halt)' : 'Within 120s threshold'}
              </span>
            </div>
            <div>
              <label className="label">Vehicle Speed: <strong>{speed} km/h</strong></label>
              <input type="range" min="0" max="110" value={speed} onChange={e => setSpeed(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
          </div>

          <button className="btn btn-ghost" style={{ width: '100%', borderColor: 'var(--status-critical)' }} onClick={sendCorridorTelemetry} disabled={busy || !incidentId}>
            🛰️ Send Route Telemetry & Test Corridor
          </button>
        </div>
      </div>

      {msg && (
        <div className="card" style={{ marginBottom: 20, padding: 12, background: 'var(--bg-panel-alt)', borderColor: 'var(--accent)' }}>
          <span className="mono" style={{ fontSize: 13 }}>{msg}</span>
        </div>
      )}
      {err && (
        <div className="card" style={{ marginBottom: 20, padding: 12, background: 'var(--status-critical-bg)', borderColor: 'var(--status-critical)' }}>
          <span className="mono" style={{ fontSize: 13, color: 'var(--status-critical)' }}>{err}</span>
        </div>
      )}

      {/* Malicious Acts & Violations Table */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">⚠️ Malicious Acts & Violation Ledger</span>
          <span className="badge badge-critical">TAMPER-EVIDENT</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
          Every corridor breach, unauthorized diversion, and whistleblower report is cryptographically hashed and permanently recorded in the database.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Violation Type</th>
              <th>Severity</th>
              <th>Penalty Fine</th>
              <th>Cryptographic Evidence Hash</th>
              <th>Detected Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {!telemetry || telemetry.violations.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  No corridor breaches or malicious acts detected for this trip.
                </td>
              </tr>
            ) : (
              telemetry.violations.map(v => (
                <tr key={v.id}>
                  <td style={{ fontWeight: 'bold' }}>
                    <span className="badge badge-critical">{v.violation_type}</span>
                  </td>
                  <td>{v.severity}</td>
                  <td style={{ color: 'var(--status-critical)', fontWeight: 'bold' }}>
                    ₹{v.penalty_inr}
                  </td>
                  <td title={v.evidence_hash} className="mono" style={{ color: 'var(--accent)' }}>
                    {v.evidence_hash.slice(0, 16)}…
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {v.detected_at ? new Date(v.detected_at).toLocaleTimeString() : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Route Breadcrumbs History */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">📍 Route GPS Breadcrumbs (Stored Route History)</span>
          <span className="badge badge-stable">DATABASE PERSISTED</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Waypoint Coordinates</th>
              <th>Speed (km/h)</th>
              <th>Lateral Deviation</th>
              <th>Halt State</th>
              <th>Recorded Time</th>
            </tr>
          </thead>
          <tbody>
            {!telemetry || telemetry.breadcrumbs.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  No GPS coordinates recorded yet.
                </td>
              </tr>
            ) : (
              telemetry.breadcrumbs.map((b, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontWeight: 'bold' }}>
                    {b.latitude.toFixed(4)}°N, {b.longitude.toFixed(4)}°E
                  </td>
                  <td>{b.speed_kmh} km/h</td>
                  <td>{b.lateral_deviation_m.toFixed(1)} m</td>
                  <td>{b.is_halt ? <span className="badge badge-warning">HALT</span> : <span className="badge badge-stable">MOVING</span>}</td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '—'}
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
