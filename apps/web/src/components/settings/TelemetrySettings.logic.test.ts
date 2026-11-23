import { expect, it } from "vite-plus/test";
import {
  nextTelemetryChoice,
  saveTelemetryChoice,
  telemetryTargetIssue,
} from "./TelemetrySettings.logic";

it("reports individual results when applying a switch to several environments", async () => {
  const preferences = { enabled: true, analytics: true, connect: true, otlp: false };
  const status = { preferences, analytics: "on", connect: "on", otlp: "off" } as const;
  const hosts = [
    { connected: true, status, writable: true, reply: { ...preferences, enabled: false } },
    { connected: false, status, writable: true },
    { connected: true, status: undefined, writable: true },
    { connected: true, status, writable: false },
    { connected: true, status, writable: true, reply: preferences },
    { connected: true, status, writable: true },
  ];
  const selection = [
    { status, issue: "denied" as const },
    { status: { ...status, preferences: { ...preferences, enabled: false } }, issue: undefined },
  ];
  expect(nextTelemetryChoice(selection, "enabled")).toBe(true);
  expect(nextTelemetryChoice([{ status, issue: undefined }, ...selection], "enabled")).toBe(false);
  const requests: number[] = [];
  const result = await Promise.all(
    hosts.map((host, index) =>
      saveTelemetryChoice(
        {
          status: host.status,
          issue: telemetryTargetIssue(host.connected, host.status, host.writable),
        },
        "enabled",
        false,
        async () => {
          requests.push(index);
          if (!host.reply) throw new Error("disconnected during save");
          return host.reply;
        },
      ),
    ),
  );
  expect(result).toEqual([
    "confirmed",
    "unavailable",
    "incompatible",
    "denied",
    "unconfirmed",
    "unconfirmed",
  ]);
  expect(requests).toEqual([0, 4, 5]);
});
