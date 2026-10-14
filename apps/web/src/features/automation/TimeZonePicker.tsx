import { Check, ChevronsUpDown, Globe } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { Sheet, TextField } from '@/ui';
import { allTimeZones, deviceTimeZone, zoneCity, zoneOffset } from './time';
import './zones.css';

export interface TimeZonePickerProps {
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
}

const LIMIT = 80;

/**
 * Which zone a schedule's clock times are in. Defaults to this device's; the
 * list is searched by city, region or offset ("berlin", "asia", "+8").
 */
export function TimeZonePicker({ value, onChange, disabled }: TimeZonePickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const device = deviceTimeZone();
  const zones = allTimeZones();

  // Offsets are worked out once per opening: a few hundred formatters are not worth repeating per keystroke.
  const offsets = useMemo(() => (open ? new Map(zones.map((zone) => [zone, zoneOffset(zone)])) : new Map<string, string>()), [open, zones]);
  const offsetOf = (zone: string) => offsets.get(zone) ?? zoneOffset(zone);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase().replace(/\s+/g, '_');
    const pinned = [...new Set([value, device, 'UTC'])];
    if (needle === '') return { pinned, rest: zones.filter((zone) => !pinned.includes(zone)).slice(0, LIMIT), more: Math.max(0, zones.length - pinned.length - LIMIT) };
    const offsetNeedle = needle.replace(/^(utc|gmt)/, '');
    const matches = zones.filter((zone) => zone.toLowerCase().includes(needle) || (offsetNeedle !== '' && (offsets.get(zone) ?? '').toLowerCase().replace('gmt', '').startsWith(offsetNeedle)));
    return { pinned: [], rest: matches.slice(0, LIMIT), more: Math.max(0, matches.length - LIMIT) };
  }, [filter, value, device, zones, offsets]);

  const choose = (zone: string) => {
    onChange(zone);
    setOpen(false);
    setFilter('');
  };

  const row = (zone: string) => (
    <li key={zone}>
      <button type="button" className="aut-zone" aria-pressed={zone === value} onClick={() => choose(zone)}>
        <span className="aut-zone__text">
          <span className="aut-zone__city">{zone === 'UTC' ? t('automation.zone.utc') : zoneCity(zone)}</span>
          <span className="aut-zone__name">
            {zone}
            {zone === device ? ` · ${t('automation.zone.device')}` : ''}
          </span>
        </span>
        <span className="aut-zone__offset u-tabular">{offsetOf(zone)}</span>
        {zone === value && <Check size={18} aria-hidden="true" className="aut-zone__check" />}
      </button>
    </li>
  );

  return (
    <>
      <button type="button" className="ui-select aut-zone-button" data-block="" disabled={disabled} onClick={() => setOpen(true)} aria-label={t('automation.zone.label', { zone: value })}>
        <Globe size={16} aria-hidden="true" />
        <span className="ui-select__value">
          {value} <span className="aut-zone-button__offset">{zoneOffset(value)}</span>
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('automation.zone.title')} fill>
        <div className="aut-zones">
          <TextField label={t('automation.zone.search')} hideLabel placeholder={t('automation.zone.search')} value={filter} onChange={setFilter} autoComplete="off" autoCapitalize="none" spellCheck={false} />
          <ul className="aut-zones__list" aria-label={t('automation.zone.title')}>
            {shown.pinned.map(row)}
            {shown.pinned.length > 0 && <li className="aut-zones__divider" role="separator" />}
            {shown.rest.map(row)}
          </ul>
          {shown.rest.length === 0 && shown.pinned.length === 0 && <p className="aut-zones__note">{t('automation.zone.none')}</p>}
          {shown.more > 0 && <p className="aut-zones__note">{t.plural('automation.zone.more', shown.more)}</p>}
        </div>
      </Sheet>
    </>
  );
}
