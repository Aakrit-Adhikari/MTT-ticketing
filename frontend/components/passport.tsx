'use client';
import { Field } from '@/components/ui';

/** One passenger's passport details as typed into a form. Number + nationality go together; expiry is optional. */
export interface PassportValue { documentNumber: string; nationality: string; documentExpiry: string }
export const noPassport = (): PassportValue => ({ documentNumber: '', nationality: '', documentExpiry: '' });

/** The fields to put in a request body (empty object when the passenger has no passport to enter). */
export const passportPayload = (p: PassportValue) =>
  p.documentNumber && p.nationality.trim()
    ? { documentNumber: p.documentNumber.trim(), nationality: p.nationality.trim(), ...(p.documentExpiry ? { documentExpiry: p.documentExpiry } : {}) }
    : {};

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const COMMON = ['Nepal', 'India'];
const OTHER = '__other__';

/** Nepal / India / Other (then type the country). Works for any value already stored. */
function NationalityField({ value, onChange, required }: { value: string; onChange: (v: string) => void; required: boolean }) {
  const isOther = value !== '' && !COMMON.includes(value);
  const selected = isOther ? OTHER : value;
  return (
    <Field label="Nationality">
      <select required={required} value={selected} onChange={(e) => onChange(e.target.value === OTHER ? ' ' : e.target.value)}>
        <option value="">Select…</option>
        <option value="Nepal">Nepal (Nepali)</option>
        <option value="India">India (Indian)</option>
        <option value={OTHER}>Other country</option>
      </select>
      {isOther && <input style={{ marginTop: 6 }} required={required} maxLength={56} autoComplete="off" placeholder="Type the country" value={value.trimStart()} onChange={(e) => onChange(e.target.value.trim() === '' ? ' ' : e.target.value)} />}
    </Field>
  );
}

/**
 * Passport number, nationality and (for staff) expiry. Renders grid cells so it can sit in any form grid.
 * Optional as a group: once the number or nationality is filled in, both are required (the server enforces the same rule).
 */
export function PassportFields({ value, onChange, required, showExpiry = true }: { value: PassportValue; onChange: (v: PassportValue) => void; required?: boolean; showExpiry?: boolean }) {
  // Only a typed number (or expiry) makes the group mandatory; a nationality picked alone is simply ignored (see passportPayload).
  const any = required || !!(value.documentNumber || value.documentExpiry);
  const set = (k: keyof PassportValue, v: string) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label={`Passport number${any ? '' : ' (optional)'}`}>
        <input required={any} maxLength={20} pattern="[A-Za-z0-9]{5,20}" title="5 to 20 letters or digits, no spaces" autoComplete="off" value={value.documentNumber} onChange={(e) => set('documentNumber', e.target.value.replace(/\s/g, ''))} />
      </Field>
      <NationalityField value={value.nationality} onChange={(v) => set('nationality', v)} required={any} />
      {showExpiry && (
        <Field label="Passport expiry (optional)">
          <input type="date" min={tomorrow()} value={value.documentExpiry} onChange={(e) => set('documentExpiry', e.target.value)} />
        </Field>
      )}
    </>
  );
}
