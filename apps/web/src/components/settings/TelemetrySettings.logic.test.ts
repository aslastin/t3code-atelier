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

it("keeps externally blocked choices off and preserves them during group writes", async () => {
  const status = {
    preferences: { enabled: true, analytics: true, connect: true, otlp: false },
    analytics: "environment",
    connect: "unavailable",
    otlp: "sdk",
  } as const;
  const locked = { status, issue: undefined };
  const available = {
    ...locked,
    status: {
      ...status,
      analytics: "off",
      otlp: "noEndpoint",
      preferences: { ...status.preferences, analytics: false },
    },
  } as const;
  expect(nextTelemetryChoice([locked, available], "analytics")).toBe(true);
  const writes: string[] = [];
  for (const reason of ["environment", "policy", "pending", "sdk"] as const) {
    const target = { ...locked, status: { ...status, connect: reason } };
    for (const value of [true, false]) {
      expect(
        await saveTelemetryChoice(target, "connect", value, async () => {
          writes.push(reason);
          return { ...status.preferences, connect: value };
        }),
      ).toBe(reason);
    }
  }
  for (const [target, key, value, outcome] of [
    [locked, "enabled", true, "allBlocked"],
    [locked, "enabled", false, "confirmed"],
    [locked, "otlp", true, "sdk"],
    [{ ...locked, status: { ...status, otlp: "exporters" } }, "otlp", true, "exporters"],
    [locked, "connect", true, "noChannel"],
    [locked, "analytics", true, "environment"],
    [available, "analytics", true, "confirmed"],
    [available, "otlp", true, "confirmed"],
    [available, "enabled", true, "confirmed"],
    [
      { ...available, blockedByDesktop: true, status: { ...available.status, connect: "off" } },
      "connect",
      true,
      "desktop",
    ],
  ] as const) {
    expect(
      await saveTelemetryChoice(target, key, value, async () => {
        writes.push(key);
        return { ...target.status.preferences, [key]: value };
      }),
    ).toBe(outcome);
  }
  expect(writes).toEqual(["enabled", "analytics", "otlp", "enabled"]);
});
