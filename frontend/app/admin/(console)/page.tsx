'use client';
import { useEffect, useState } from 'react';
import Calendar from '@/components/Calendar';
import { adminApi } from '@/lib/api';

interface Summary { bookingsByStatus: Record<string, number>; holdsExpiringWithin2h: number; upcomingFlights: number }
const ORDER = ['INQUIRY', 'HELD', 'CONFIRMED', 'TICKETED', 'CANCELLED', 'EXPIRED', 'REJECTED'];

export default function Dashboard() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { adminApi<Summary>('/admin/bookings-summary').then(setS).catch((e) => setErr(e.message)); }, []);

  return (
    <>
      <h1>Dashboard</h1>
      {err && <p className="error">{err}</p>}
      {s && (
        <>
          <div className="kpis">
            {ORDER.map((k) => <div className="kpi" key={k}><b>{s.bookingsByStatus[k] ?? 0}</b>{k.toLowerCase()}</div>)}
          </div>
          <div className="kpis">
            <div className="kpi"><b>{s.holdsExpiringWithin2h}</b>holds lapsing within 2h</div>
            <div className="kpi"><b>{s.upcomingFlights}</b>scheduled departures</div>
          </div>
          <p className="muted sm">Inquiries need action: open Inquiries, check availability with the airline, then hold or confirm.</p>
        </>
      )}
      <Calendar />
    </>
  );
}
