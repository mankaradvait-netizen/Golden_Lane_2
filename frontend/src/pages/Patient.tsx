import { useEffect, useState } from 'react';
import type { Session } from '../App';
import {
  apiGetIncident,
  connectWs,
  apiSos,
  apiGetAudit,
  apiFileComplaint,
  type IncidentDetails,
  type AuditRecord,
} from '../api';

export default function Patient({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [activeIncidentId, setActiveIncidentId] = useState<string>(
    session.incidentId ?? (session.initialIncident?.incident_id as string) ?? ''
  );
  const [incident, setIncident] = useState<IncidentDetails | null>(null);
  const [auditTrail, setAuditTrail] = useState<AuditRecord[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [complaintMsg, setComplaintMsg] = useState<string | null>(null);
  const [complaintNotes, setComplaintNotes] = useState('');
  const [complaintCategory, setComplaintCategory] = useState('BRIBE_SOLICITATION');

  // Initial fetch and periodic refresh
  async function loadData(targetId: string) {
    try {
      const data = await apiGetIncident(targetId, session.token);
      if (data && data.id) {
        setIncident(data);
        setActiveIncidentId(data.id);
      }
      const audit = await apiGetAudit(targetId, session.token);
      if (audit && audit.audit_trail) {
        setAuditTrail(audit.audit_trail);
      }
    } catch (e) {
      console.warn('Failed to fetch incident data:', e);
    }
  }

  useEffect(() => {
    const target = activeIncidentId || 'latest';
    loadData(target);
    const interval = setInterval(() => {
      loadData(target);
    }, 4000);
    return () => clearInterval(interval);
  }, [activeIncidentId, session.token]);

  // WebSocket Live Subscription
  useEffect(() => {
    if (!activeIncidentId) return;
    return connectWs(activeIncidentId, (m) => {
      const msg = m as {
        type: string;
        state?: string;
        band?: string;
        dev_m?: number;
        sla?: number;
        category?: string;
      };
      setEvents(prev => [
        `[${new Date().toLocaleTimeString()}] ${msg.type.toUpperCase()}: ${JSON.stringify(m)}`,
        ...prev,
      ].slice(0, 10));

      if (msg.type === 'bed_state' && msg.state) {
        setIncident(prev => (prev ? { ...prev, bed_state: msg.state! } : prev));
      }
      if (msg.type === 'vitals' && msg.band) {
        setIncident(prev => (prev ? { ...prev, band: msg.band! } : prev));
      }
      if (msg.type === 'corridor' || msg.type === 'violation') {
        if (msg.dev_m !== undefined) {
          setIncident(prev => (prev ? { ...prev, deviation_m: msg.dev_m! } : prev));
        }
        if (msg.sla !== undefined) {
          setIncident(prev => (prev ? { ...prev, sla_penalty_inr: msg.sla! } : prev));
        }
      }
      // Reload audit ledger on new events
      loadData(activeIncidentId);
    });
  }, [activeIncidentId]);

  async function triggerSos() {
    setBusy(true);
    try {
      let lat = 18.5204;
      let lng = 73.8567;
      if (navigator.geolocation) {
        try {
          const pos = await new Promise<GeolocationPosition>((res, rej) =>
            navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000 })
          );
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
        } catch { /* use default */ }
      }
      const r = await apiSos(lat, lng, {
        name: 'Aarav Kulkarni',
        phone: '+919820112233',
        abha: '91-4521-8834-0912',
        blood_group: 'O+',
        allergies: 'Penicillin, Sulfa drugs',
        medical_history: 'Hypertension, Mild Asthma',
      });
      setActiveIncidentId(r.incident_id);
      loadData(r.incident_id);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function submitComplaint(e: React.FormEvent) {
    e.preventDefault();
    if (!activeIncidentId) return;
    setBusy(true);
    setComplaintMsg(null);
    try {
      const res = await apiFileComplaint({
        incident_id: activeIncidentId,
        category: complaintCategory,
        notes: complaintNotes,
        lat: incident?.current_lat || 18.5204,
        lng: incident?.current_lng || 73.8567,
      }, session.token);
      setComplaintMsg(`Evidence SHA-256 Hash: ${res.evidence_hash.slice(0, 16)}… - Reported to NHM Auditor!`);
      setComplaintNotes('');
      loadData(activeIncidentId);
    } catch (err) {
      setComplaintMsg('Failed to submit whistleblower report.');
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
      {/* Top Incident Status Banner */}
      <div className="card" style={{ marginBottom: 20, borderLeft: '6px solid var(--accent)', background: 'linear-gradient(90deg, var(--bg-panel) 0%, var(--bg-panel-alt) 100%)' }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="live-pulse" />
              <h2 style={{ fontSize: 20, fontWeight: 800 }}>ACTIVE EMERGENCY GREEN CORRIDOR</h2>
              <span className={`badge badge-${incident?.band === 'CRITICAL' ? 'critical' : 'stable'}`}>
                {incident?.band || 'DISPATCH PENDING'}
              </span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
              Incident Ref: <span className="mono" style={{ userSelect: 'all', fontWeight: 'bold' }}>{incident?.id || 'Allocating...'}</span> · Protected under Article 21 Anti-Nexus SLA
            </p>
          </div>
          <div className="row">
            {!incident && (
              <button className="btn btn-danger" onClick={triggerSos} disabled={busy}>
                {busy ? 'Dispatching…' : '🚨 Trigger Emergency SOS'}
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => loadData(activeIncidentId || 'latest')} type="button">
              🔄 Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        {/* Metric Box 1: Hospital Assignment */}
        <div className="metric-box">
          <div className="metric-lbl">Assigned Hospital</div>
          <div className="metric-val" style={{ fontSize: 18, color: 'var(--accent)' }}>
            {incident?.primary_hospital || 'Sahyadri Trauma ED'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Backup: {incident?.backup_hospital || 'Ruby Hall Neuro Trauma'}
          </div>
        </div>

        {/* Metric Box 2: Bed Lock State */}
        <div className="metric-box">
          <div className="metric-lbl">Bed Guarantee State</div>
          <div className="metric-val" style={{ fontSize: 18, color: incident?.bed_state === 'PHASE_2_CONFIRMED' ? 'var(--status-stable)' : 'var(--status-warning)' }}>
            {incident?.bed_state || 'PHASE_1_RESERVED'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {incident?.bed_state === 'PHASE_2_CONFIRMED' ? 'Hard Lock Persisted by ED' : '10-Min Temporary Holding Lock'}
          </div>
        </div>

        {/* Metric Box 3: Anti-Nexus Corridor Guard */}
        <div className="metric-box">
          <div className="metric-lbl">Corridor Lateral Deviation</div>
          <div className="metric-val" style={{ fontSize: 18, color: (incident?.deviation_m || 0) > 250 ? 'var(--status-critical)' : 'var(--status-stable)' }}>
            {(incident?.deviation_m || 0).toFixed(1)} m
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            SLA Fine Levied: ₹{incident?.sla_penalty_inr || 0}
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        {/* Patient Dossier Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">👤 Patient Emergency Dossier</span>
            <span className="badge badge-accent">ABHA VERIFIED</span>
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div>
              <span className="label">Full Name</span>
              <div className="mono" style={{ fontSize: 13, fontWeight: 'bold' }}>{patientInfo.name}</div>
            </div>
            <div>
              <span className="label">ABHA ID (Ayushman)</span>
              <div className="mono" style={{ fontSize: 13, color: 'var(--accent)' }}>{patientInfo.abha}</div>
            </div>
            <div>
              <span className="label">Blood Group</span>
              <div className="mono" style={{ fontSize: 14, fontWeight: 'bold', color: 'var(--status-critical)' }}>
                🩸 {patientInfo.blood_group}
              </div>
            </div>
            <div>
              <span className="label">Emergency Contact</span>
              <div className="mono" style={{ fontSize: 13 }}>Sunita Kulkarni (Wife) · +919820998877</div>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <span className="label">Severe Drug Allergies</span>
              <div className="mono" style={{ fontSize: 13, color: 'var(--status-critical)' }}>
                ⚠️ {patientInfo.allergies}
              </div>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <span className="label">Pre-Existing Conditions</span>
              <div className="mono" style={{ fontSize: 13 }}>{patientInfo.medical_history}</div>
            </div>
          </div>
        </div>

        {/* Whistleblower Anti-Nexus Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🛡️ Anti-Nexus Whistleblower & Tamper Protection</span>
            <span className="badge badge-critical">NHM AUDIT</span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
            If the ambulance driver or hospital attempts unauthorized diversion, solicit kickbacks, or delay transit, report instantly. All submissions are appended to an immutable SHA-256 hash ledger.
          </p>
          <form onSubmit={submitComplaint}>
            <div style={{ marginBottom: 12 }}>
              <label className="label">Report Category</label>
              <select
                className="input mono"
                value={complaintCategory}
                onChange={e => setComplaintCategory(e.target.value)}
              >
                <option value="BRIBE_SOLICITATION">Bribe / Cash Demand by EMT</option>
                <option value="UNAUTHORIZED_DIVERSION">Unauthorized Diversion to Private Nursing Home</option>
                <option value="EQUIPMENT_FAILURE">Ambulance Equipment Tampered / Missing</option>
                <option value="DELAY_DELIBERATE">Deliberate Transit Delay / Halting</option>
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="label">Incident Notes / Audio Witness</label>
              <input
                className="input"
                placeholder="Describe details (GPS & timestamp will be cryptographically anchored)"
                value={complaintNotes}
                onChange={e => setComplaintNotes(e.target.value)}
                required
              />
            </div>
            <button className="btn btn-danger" style={{ width: '100%' }} disabled={busy || !activeIncidentId}>
              🚨 Submit Tamper-Proof Whistleblower Report
            </button>
          </form>
          {complaintMsg && (
            <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-panel-alt)', borderRadius: 8, fontSize: 12, color: 'var(--status-stable)', border: '1px solid var(--status-stable)' }} className="mono">
              ✓ {complaintMsg}
            </div>
          )}
        </div>
      </div>

      {/* Live Blockchain-style Audit Ledger */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">⛓️ Cryptographic Audit Ledger (SHA-256 Hash Chain)</span>
          <span className="badge badge-stable">TAMPER-PROOF</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
          Every dispatch, vital telemetry push, corridor deviation, and bed lock is chained sequentially. Database triggers permanently block any UPDATE or DELETE operations.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Event Type</th>
                <th>Actor Role</th>
                <th>Previous Hash (SHA-256)</th>
                <th>Current Block Hash (SHA-256)</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {auditTrail.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    No audit records logged yet.
                  </td>
                </tr>
              ) : (
                auditTrail.map(a => (
                  <tr key={a.seq}>
                    <td style={{ fontWeight: 'bold' }}>#{a.seq}</td>
                    <td>
                      <span className="badge badge-accent">{a.event_type}</span>
                    </td>
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

      {/* Live WebSocket Event Stream */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">📡 Live Telemetry Broadcast Stream</span>
          <span className="badge badge-stable">WS CONNECTED</span>
        </div>
        {events.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Listening on WebSocket for real-time telemetry updates…</p>
        ) : (
          <pre className="mono" style={{ fontSize: 11, background: 'var(--bg-panel-alt)', padding: 12, borderRadius: 8, overflowX: 'auto', margin: 0 }}>
            {events.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
