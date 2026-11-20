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
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const initialTheme = session?.role === 'AMBULANCE_EMT' ? 'dark' : 'light';
    setTheme(initialTheme);
  }, [session]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggleTheme() {
    setTheme(prev => (prev === 'light' ? 'dark' : 'light'));
  }

  return (
    <div>
      <nav className="navbar">
        <div className="nav-inner">
          <div className="brand-group">
            <span className="live-pulse" title="System Live" />
            <span className="brand-title">
              GOLDEN LANE <span style={{ color: 'var(--accent)', fontWeight: 600 }}>EMS</span>
            </span>
            <span className="badge badge-accent" style={{ fontSize: 10 }}>ANTI-NEXUS 2.0</span>
          </div>
          <div className="row">
            <span className="badge badge-critical" style={{ cursor: 'default' }}>
              HELPLINE: 108
            </span>
            <button
              className="btn btn-ghost"
              style={{ padding: '6px 12px', fontSize: 12 }}
              onClick={toggleTheme}
              type="button"
              title="Toggle Night / Day Vision"
            >
              {theme === 'dark' ? '☀️ Day View' : '🌙 Night HUD'}
            </button>
            {session && (
              <>
                <span className="badge badge-stable" style={{ textTransform: 'uppercase' }}>
                  {session.role.replace('_', ' ')}
                </span>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => setSession(null)}
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      <main>
        {!session && <Login onSession={setSession} />}
        {session?.role === 'PATIENT' && <Patient session={session} onLogout={() => setSession(null)} />}
        {session?.role === 'AMBULANCE_EMT' && <Emt session={session} onLogout={() => setSession(null)} />}
        {session?.role === 'HOSPITAL_ED' && <Hospital session={session} onLogout={() => setSession(null)} />}
      </main>
    </div>
  );
}

function Login({ onSession }: { onSession: (s: Session) => void }) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('demo1234');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [geoLoc, setGeoLoc] = useState('Detecting GPS...');

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => setGeoLoc(`${pos.coords.latitude.toFixed(4)}°N, ${pos.coords.longitude.toFixed(4)}°E (Live GPS)`),
        () => setGeoLoc('18.5204°N, 73.8567°E (Pune Core Default)')
      );
    } else {
      setGeoLoc('18.5204°N, 73.8567°E (Pune Core Default)');
    }
  }, []);

  async function handleLogin(userToAuth: string, passToAuth: string) {
    setErr(null);
    setBusy(true);
    try {
      const r = await apiLogin(userToAuth.trim(), passToAuth);
      onSession({ token: r.token, role: r.role, name: r.name, entityId: r.entity_id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  async function triggerSos() {
    setErr(null);
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
        name: 'Emergency Patient (Aarav Kulkarni)',
        phone: '+919820112233',
        abha: '91-4521-8834-0912',
        blood_group: 'O+',
        allergies: 'Penicillin, Sulfa drugs',
        medical_history: 'Hypertension, Mild Asthma',
      });
      onSession({
        token: r.token || '',
        role: 'PATIENT',
        name: 'Aarav Kulkarni',
        entityId: '9820112233',
        incidentId: r.incident_id,
        initialIncident: {
          ...r,
          band: 'CRITICAL',
          rts: 0,
          sla_penalty_inr: 0,
        },
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Emergency SOS dispatch failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 980, paddingTop: 40, paddingBottom: 60 }}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8, letterSpacing: '-0.02em' }}>
          Anti-Nexus Emergency Medical Routing
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 15, maxWidth: 600, margin: '0 auto' }}>
          Deterministic hospital assignment, corridor SLA enforcement, and tamper-proof SHA-256 audit ledgers.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 32, textAlign: 'center', padding: '32px 24px', background: 'linear-gradient(180deg, var(--bg-panel) 0%, var(--bg-panel-alt) 100%)' }}>
        <span className="badge badge-critical" style={{ marginBottom: 12 }}>CRITICAL RESPONSE OVERRIDE</span>
        <h2 style={{ fontSize: 24, marginBottom: 8 }}>One-Tap Emergency Dispatch</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
          Location: <strong className="mono">{geoLoc}</strong> · Auto-reserves nearest capable ICU bed within 30 km.
        </p>
        <button className="btn-sos" onClick={triggerSos} disabled={busy} type="button">
          🚨 DISPATCH EMERGENCY SOS (NO LOGIN)
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>
          ⚡ Quick Demo Persona Access (Password: demo1234)
        </h3>
        <div className="grid grid-3">
          <div className="persona-card" onClick={() => handleLogin('AMB-108', 'demo1234')}>
            <div className="persona-title">
              <span>🚑</span> Ambulance EMT
            </div>
            <div className="persona-desc">
              <strong>AMB-108</strong> · Tactical cockpit, live RTS vitals telemetry, corridor deviation alerts & SLA penalizer.
            </div>
          </div>

          <div className="persona-card" onClick={() => handleLogin('HOSP-01', 'demo1234')}>
            <div className="persona-title">
              <span>🏥</span> Hospital ED Triage
            </div>
            <div className="persona-desc">
              <strong>HOSP-01</strong> · Sahyadri Trauma ED, Phase 2 Bed Lock hard confirmation, incoming ambulance board.
            </div>
          </div>

          <div className="persona-card" onClick={() => handleLogin('9820112233', 'demo1234')}>
            <div className="persona-title">
              <span>👤</span> Emergency Patient
            </div>
            <div className="persona-desc">
              <strong>9820112233</strong> · Live hospital allocation transparency, real-time ETA countdown & whistleblower.
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 440, margin: '24px auto 0' }}>
        <div className="card-header">
          <span className="card-title">Manual Gateway Login</span>
          <span className="badge badge-accent">SECURE</span>
        </div>
        <form onSubmit={e => { e.preventDefault(); handleLogin(loginId, password); }}>
          <div style={{ marginBottom: 14 }}>
            <label className="label">Login ID / Mobile / Role</label>
            <input
              className="input mono"
              value={loginId}
              onChange={e => setLoginId(e.target.value)}
              placeholder="e.g. 9820112233, AMB-108, HOSP-01"
              required
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="label">Password</label>
            <input
              className="input mono"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          {err && <p style={{ color: 'var(--status-critical)', fontSize: 13, margin: '0 0 12px' }}>{err}</p>}
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Verifying Credentials…' : 'Authenticate Session'}
          </button>
        </form>
      </div>
    </div>
  );
}
