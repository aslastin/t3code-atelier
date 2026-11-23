import type { TelemetryPreferences, TelemetryStatus } from "@t3tools/contracts";

export function telemetryTargetIssue(
  connected: boolean,
  status: TelemetryStatus | undefined,
  writable: boolean,
) {
  if (!connected) return "unavailable";
  if (!status) return "incompatible";
  if (!writable) return "denied";
  return undefined;
}

export async function saveTelemetryChoice(
  target: { status: TelemetryStatus | undefined; issue: ReturnType<typeof telemetryTargetIssue> },
  key: keyof TelemetryPreferences,
  value: boolean,
  persist: () => Promise<TelemetryPreferences | undefined>,
) {
  if (target.issue) return target.issue;
  if (key === "connect" && target.status?.connect === "unavailable") return "noChannel";
  const saved = await persist().catch(() => undefined);
  return saved?.[key] === value ? "confirmed" : "unconfirmed";
}
