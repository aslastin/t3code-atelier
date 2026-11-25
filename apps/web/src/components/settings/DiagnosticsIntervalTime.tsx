import { useLocale } from "gt-react";
import * as DateTime from "effect/DateTime";
import { useClientSettings } from "~/hooks/useSettings";

export function DiagnosticsIntervalTime({
  bucket,
}: {
  bucket: { startedAt: DateTime.Utc; endedAt: DateTime.Utc };
}) {
  const locale = useLocale();
  const clock = useClientSettings((settings) => settings.timestampFormat);
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
    ...(clock === "locale" ? {} : { hour12: clock === "12-hour" }),
  });
  return (
    <div className="font-medium tabular-nums">
      {format.formatRange(
        DateTime.toEpochMillis(bucket.startedAt),
        DateTime.toEpochMillis(bucket.endedAt),
      )}
    </div>
  );
}
