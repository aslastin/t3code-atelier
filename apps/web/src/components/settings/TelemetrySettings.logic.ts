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

type TelemetryTarget = {
  status: TelemetryStatus | undefined;
  issue: ReturnType<typeof telemetryTargetIssue>;
  blockedByDesktop?: boolean;
};

const channels = ["analytics", "connect", "otlp"] as const;

function channelBlock(target: TelemetryTarget, channel: (typeof channels)[number]) {
  if (channel === "connect" && target.blockedByDesktop) return "desktop";
  const state = target.status?.[channel];
  if (state === "unavailable") return "noChannel";
  if (state === "on" || state === "off" || state === "noEndpoint") return undefined;
  return state;
}

export function telemetryChoiceSelected(target: TelemetryTarget, key: keyof TelemetryPreferences) {
  return (
    target.status?.preferences[key] === true && (key === "enabled" || !channelBlock(target, key))
  );
}

export function telemetryChoiceIssue(
  target: TelemetryTarget,
  key: keyof TelemetryPreferences,
  value: boolean,
) {
  if (target.issue) return target.issue;
  if (!target.status) return "incompatible";
  if (key !== "enabled") return channelBlock(target, key);
  if (value && channels.every((channel) => channelBlock(target, channel))) return "allBlocked";
  return undefined;
}

export function nextTelemetryChoice(
  targets: ReadonlyArray<TelemetryTarget>,
  key: keyof TelemetryPreferences,
) {
  return !targets.some((target) => !target.issue && telemetryChoiceSelected(target, key));
}

export async function saveTelemetryChoice(
  target: TelemetryTarget,
  key: keyof TelemetryPreferences,
  value: boolean,
  persist: () => Promise<TelemetryPreferences | undefined>,
) {
  const issue = telemetryChoiceIssue(target, key, value);
  if (issue) return issue;
  const saved = await persist().catch(() => undefined);
  return saved?.[key] === value ? "confirmed" : "unconfirmed";
}
