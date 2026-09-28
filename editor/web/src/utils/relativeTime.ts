import { t } from "../i18n";

/** Relative "hace X" label for an ISO timestamp, coarse enough to not need a library; the copy lives in the locale resource (`time.*`). Shared by the profile picker's brand cards and the brand home dashboard's carousel cover cards. */
export function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("time.days", { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? t("time.oneMonth") : t("time.months", { count: months });
  const years = Math.round(months / 12);
  return years === 1 ? t("time.oneYear") : t("time.years", { count: years });
}
