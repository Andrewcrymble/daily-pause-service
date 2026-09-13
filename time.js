/**
 * Local-time helpers.
 *
 * The slots are wall-clock times in Europe/London — 08:00 means eight in the
 * morning in Belfast, in July and in January. Storing UTC offsets would break
 * twice a year, so the instant is computed from the zone each time.
 */

/** What a given instant looks like in `tz`, as numbers. */
function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    fmt.formatToParts(date).filter((x) => x.type !== 'literal')
       .map((x) => [x.type, Number(x.value)])
  );
  // en-GB renders midnight as 24; normalise.
  if (p.hour === 24) p.hour = 0;
  return p;
}

/**
 * The UTC instant at which the clock in `tz` reads yyyy-mm-dd hh:mm.
 *
 * Done by guess-and-correct: treat the wall time as if it were UTC, see how far
 * that lands from the target once rendered in the zone, and shift by the error.
 * Two passes settle it, including across a DST boundary.
 */
export function zonedToUtc(dateStr, hh, mm, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0);

  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(y, mo - 1, d, hh, mm, 0);
    const drift = seen - want;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/** Today's date in `tz`, as yyyy-mm-dd. */
export function todayIn(tz, now = new Date()) {
  const p = partsIn(now, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function isDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && !Number.isNaN(Date.parse(s));
}
