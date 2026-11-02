'use client';
import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { DeleteButton, Field } from '@/components/ui';
import { adminApi, adminUpload } from '@/lib/api';

interface Airline { id: string; code: string; name: string; isActive: boolean; logoUrl: string | null }
interface Airport { id: string; iata: string; name: string; city: string }
interface Sector { id: string; name: string; isActive: boolean }

const MAX_LOGO = 1024 * 1024; // 1 MB, enforced again by the server

export default function Masters() {
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [airlines, setAirlines] = useState<Airline[]>([]);
  const [airports, setAirports] = useState<Airport[]>([]);
  const [al, setAl] = useState({ code: '', name: '' });
  const [logo, setLogo] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0); // changing the key clears the file input
  const [ap, setAp] = useState({ iata: '', name: '', city: '' });
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [sectorName, setSectorName] = useState('');
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    adminApi<Airline[]>('/admin/airlines').then(setAirlines).catch((e) => setErr(e.message));
    adminApi<Airport[]>('/admin/airports').then(setAirports).catch((e) => setErr(e.message));
    adminApi<Sector[]>('/admin/sectors').then(setSectors).catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  /** Returns an error message if the file can't be used as a logo. */
  const checkFile = (f: File | null): string => {
    if (!f) return '';
    if (!f.type.startsWith('image/')) return 'Please choose an image file (PNG, JPG, GIF, WebP, AVIF, BMP, ICO or SVG).';
    if (f.size > MAX_LOGO) return `That image is ${(f.size / 1024 / 1024).toFixed(1)} MB. The logo must be smaller than 1 MB.`;
    return '';
  };

  function pickNew(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    const m = checkFile(f);
    setErr(m);
    if (m) { setLogo(null); setFileKey((k) => k + 1); } else setLogo(f);
  }

  async function addAirline(e: FormEvent) {
    e.preventDefault(); setErr('');
    const m = checkFile(logo);
    if (m) { setErr(m); return; }
    try {
      const created = await adminApi<Airline>('/admin/airlines', 'POST', al);
      if (logo) {
        try { await adminUpload(`/admin/airlines/${created.id}/logo`, logo); }
        catch (x) { setErr(`Airline added, but the logo was not saved: ${(x as Error).message}`); }
      }
      setAl({ code: '', name: '' }); setLogo(null); setFileKey((k) => k + 1); load();
    } catch (x) { setErr((x as Error).message); }
  }

  async function addAirport(e: FormEvent) {
    e.preventDefault(); setErr('');
    try { await adminApi('/admin/airports', 'POST', ap); setAp({ iata: '', name: '', city: '' }); load(); } catch (x) { setErr((x as Error).message); }
  }

  async function addSector(e: FormEvent) {
    e.preventDefault(); setErr('');
    try { await adminApi('/admin/sectors', 'POST', { name: sectorName }); setSectorName(''); load(); } catch (x) { setErr((x as Error).message); }
  }
  async function toggleSector(sc: Sector) {
    try { await adminApi(`/admin/sectors/${sc.id}`, 'PATCH', { isActive: !sc.isActive }); load(); } catch (x) { setErr((x as Error).message); }
  }

  async function toggle(a: Airline) {
    try { await adminApi(`/admin/airlines/${a.id}`, 'PATCH', { isActive: !a.isActive }); load(); } catch (x) { setErr((x as Error).message); }
  }

  async function changeLogo(a: Airline, e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = '';
    const m = checkFile(f);
    if (m || !f) { setErr(m); return; }
    setErr(''); setBusyId(a.id);
    try { await adminUpload(`/admin/airlines/${a.id}/logo`, f); load(); } catch (x) { setErr((x as Error).message); } finally { setBusyId(''); }
  }

  async function removeLogo(a: Airline) {
    setErr(''); setBusyId(a.id);
    try { await adminApi(`/admin/airlines/${a.id}/logo`, 'DELETE'); load(); } catch (x) { setErr((x as Error).message); } finally { setBusyId(''); }
  }

  return (
    <>
      <h1>Airlines &amp; airports</h1>
      {err && <p className="error" role="alert">{err}</p>}
      <h2>Airlines</h2>
      {isSuper && (
        <form className="panel grid" onSubmit={addAirline}>
          <Field label="IATA code"><input required pattern="[A-Z0-9]{2,3}" maxLength={3} value={al.code} onChange={(e) => setAl({ ...al, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name"><input required maxLength={100} value={al.name} onChange={(e) => setAl({ ...al, name: e.target.value })} /></Field>
          <Field label="Logo (optional, image under 1 MB)"><input key={fileKey} type="file" accept="image/*" onChange={pickNew} /></Field>
          <button className="add-btn">Add airline</button>
        </form>
      )}
      <table><thead><tr><th>Logo</th><th>Code</th><th>Name</th><th>Active</th><th></th></tr></thead>
        <tbody>{airlines.map((a) => (
          <tr key={a.id}>
            <td className="narrow">
              {a.logoUrl ? <img src={a.logoUrl} alt={`${a.name} logo`} className="logo-thumb" /> : <span className="muted sm">none</span>}
            </td>
            <td>{a.code}</td><td>{a.name}</td><td>{a.isActive ? 'Yes' : 'No'}</td>
            <td>
              {isSuper && (
                <div className="row">
                  <button className="secondary" onClick={() => toggle(a)}>{a.isActive ? 'Deactivate' : 'Activate'}</button>
                  <label className="btn secondary file-btn" style={{ margin: 0 }}>
                    {busyId === a.id ? 'Saving…' : a.logoUrl ? 'Replace logo' : 'Upload logo'}
                    <input type="file" accept="image/*" hidden disabled={busyId === a.id} onChange={(e) => changeLogo(a, e)} />
                  </label>
                  {a.logoUrl && <button className="secondary" disabled={busyId === a.id} onClick={() => removeLogo(a)}>Remove logo</button>}
                  <DeleteButton what={`airline ${a.name}`} extra="Only possible when it has no flights." onDelete={async () => { await adminApi(`/admin/airlines/${a.id}`, 'DELETE'); load(); }} />
                </div>
              )}
            </td>
          </tr>
        ))}</tbody></table>

      <h2>Airports</h2>
      {isSuper && (
        <form className="panel grid" onSubmit={addAirport}>
          <Field label="IATA"><input required pattern="[A-Z]{3}" maxLength={3} value={ap.iata} onChange={(e) => setAp({ ...ap, iata: e.target.value.toUpperCase() })} /></Field>
          <Field label="Airport name"><input required maxLength={100} value={ap.name} onChange={(e) => setAp({ ...ap, name: e.target.value })} /></Field>
          <Field label="City"><input required maxLength={100} value={ap.city} onChange={(e) => setAp({ ...ap, city: e.target.value })} /></Field>
          <button className="add-btn">Add airport</button>
        </form>
      )}
      <table><thead><tr><th>IATA</th><th>Name</th><th>City</th><th></th></tr></thead>
        <tbody>{airports.map((a) => <tr key={a.id}><td>{a.iata}</td><td>{a.name}</td><td>{a.city}</td><td>{isSuper && <DeleteButton what={`airport ${a.iata}`} extra="Only possible when no flight uses it." onDelete={async () => { await adminApi(`/admin/airports/${a.id}`, 'DELETE'); load(); }} />}</td></tr>)}</tbody></table>

      <h2>Sectors</h2>
      <p className="muted sm">For flights that do not go from one airport to another, such as a mountain flight. A sector is just a name: no airports, no arrival time, one way only. Customers pick it from a single box.</p>
      {user?.role !== 'FINANCE_STAFF' && (
        <form className="panel grid" onSubmit={addSector}>
          <Field label="Sector name"><input required minLength={2} maxLength={100} placeholder="e.g. Everest Mountain Flight" value={sectorName} onChange={(e) => setSectorName(e.target.value)} /></Field>
          <button className="add-btn">Add sector</button>
        </form>
      )}
      <table><thead><tr><th>Name</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {sectors.map((sc) => <tr key={sc.id}><td>{sc.name}</td><td>{sc.isActive ? 'Yes' : 'No'}</td><td>{user?.role !== 'FINANCE_STAFF' && <span className="row"><button className="secondary" onClick={() => toggleSector(sc)}>{sc.isActive ? 'Deactivate' : 'Activate'}</button><DeleteButton what={`sector ${sc.name}`} extra="Only possible when it has no flights." onDelete={async () => { await adminApi(`/admin/sectors/${sc.id}`, 'DELETE'); load(); }} /></span>}</td></tr>)}
          {sectors.length === 0 && <tr><td colSpan={3} className="muted">No sectors yet.</td></tr>}
        </tbody></table>
    </>
  );
}
