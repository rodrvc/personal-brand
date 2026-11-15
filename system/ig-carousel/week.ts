/** The Monday of the Mon-Sun week containing `reference`. */
export function mondayOf(reference: Date): Date {
  const day = reference.getDay(); // 0 = Sunday
  const monday = new Date(reference);
  monday.setDate(reference.getDate() + (day === 0 ? -6 : 1 - day));
  return monday;
}

/**
 * The content date of a weekly carousel (`AAAA-MM-DD`): the first day of the published week, the same rule as a reel's
 * `periodStart`. It picks a stored brand's seasonal theme, whatever day inside the week the render ran on.
 */
// The week reference is the machine's local date, like render-week.ts; this is the single place to change if it must follow the brand timezone.
export function weekContentDay(reference: Date): string {
  const monday = mondayOf(reference);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}
