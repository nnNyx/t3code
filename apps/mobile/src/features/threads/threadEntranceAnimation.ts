// Entrance animations must only play for rows that appeared AFTER the user
// opened the thread. Opening a thread hydrates the whole history at once; a
// wall-clock "created in the last few seconds" test replays FadeIn entrances
// for every historical row when the thread was active moments ago — dozens of
// simultaneous animations that stutter first paint. Gate on the open time
// instead: a row animates only if it was created after the thread was opened
// (genuinely new) and is still within the freshness window (rows also remount
// when scrolled back into view, and must not re-enter then).
const FRESH_ENTRY_WINDOW_MS = 3_000;

export function shouldPlayEntrance(
  createdAt: string,
  openedAt: number,
  now: number = Date.now(),
): boolean {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp >= openedAt && now - timestamp < FRESH_ENTRY_WINDOW_MS;
}
