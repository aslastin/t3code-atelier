import {
  AuthSettingsWriteScope,
  type TelemetryPreferences,
  type TelemetryStatus,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { relayTracingDestination, relayTelemetryEnabled } from "../../cloud/publicConfig";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { TelemetryExportSettings } from "./TelemetryExportSettings";

import { saveTelemetryChoice, telemetryTargetIssue } from "./TelemetrySettings.logic";

const outcomes = {
  unavailable: msg("Unavailable"),
  incompatible: msg("Incompatible server"),
  denied: msg("Permission denied"),
  confirmed: msg("Confirmed"),
  unconfirmed: msg("Not confirmed"),
  noChannel: msg("Unavailable in this build"),
} as const;

const channels = {
  analytics: msg("T3 product analytics (PostHog)"),
  connect: msg("T3 Connect tracing (Axiom)"),
  otlp: msg("My OpenTelemetry receiver"),
} as const;

const reasons = {
  on: msg("On"),
  off: msg("Off", { $context: "export disabled" }),
  sdk: msg("OpenTelemetry SDK disabled"),
  policy: msg("Blocked by managed policy"),
  environment: msg("Disabled by T3CODE_TELEMETRY_ENABLED"),
  pending: msg("Waiting for shell settings"),
  unavailable: msg("Unavailable in this build"),
  noEndpoint: msg("No OTLP endpoint configured"),
} satisfies Record<TelemetryStatus["otlp"], unknown>;

export function TelemetrySettings() {
  const gt = useGT();
  const m = useMessages();
  const { environments, connectedEnvironments, scope } = useSettingsScope();
  const primaryId = usePrimaryEnvironmentId();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<ReadonlyMap<string, keyof typeof outcomes>>(new Map());
  const [expanded, setExpanded] = useState(false);
  if (scope.kind !== "environment" && scope.kind !== "all") return null;

  const targets = environments.map((env) => {
    const connected = env.connection.phase === "connected" && !!env.serverConfig;
    let status = connected ? env.serverConfig?.observability.telemetry : undefined;
    let blockedByDesktop = false;
    if (
      status?.connect === "unavailable" &&
      env.environmentId === primaryId &&
      relayTracingDestination() &&
      status.rendererConnect
    ) {
      const allowed = relayTelemetryEnabled();
      blockedByDesktop = allowed === false && status.rendererConnect === "on";
      status = {
        ...status,
        connect:
          status.rendererConnect !== "on" || allowed === true
            ? status.rendererConnect
            : allowed === null
              ? "pending"
              : "off",
      };
    }
    return {
      env,
      status,
      blockedByDesktop,
      issue: telemetryTargetIssue(connected, status, writable.has(env.environmentId)),
    } as const;
  });

  const summary = (status: TelemetryStatus) => {
    const count = [status.analytics, status.connect, status.otlp].filter(
      (value) => value === "on",
    ).length;
    if (count === 0) return m(reasons.off);
    if (count === 1 && status.otlp === "on") return gt("Only my OpenTelemetry receiver");
    return gt("Active channels: {count}", { count });
  };
  const write = async (key: keyof TelemetryPreferences, value: boolean) => {
    if (
      key === "enabled" &&
      value &&
      targets.some(
        ({ status }) =>
          status &&
          !status.preferences.analytics &&
          !status.preferences.connect &&
          !status.preferences.otlp,
      )
    ) {
      setExpanded(true);
    }
    setSaving(true);
    setReport(
      new Map(
        await Promise.all(
          targets.map(async (target) => {
            const outcome = await saveTelemetryChoice(target, key, value, async () => {
              const response = await update({
                environmentId: target.env.environmentId,
                input: { patch: { observability: { telemetry: { [key]: value } } } },
              });
              return response._tag === "Success"
                ? response.value.observability.telemetry
                : undefined;
            });
            return [target.env.environmentId, outcome] as const;
          }),
        ),
      ),
    );
    setSaving(false);
  };

  const row = (key: keyof TelemetryPreferences, label: string) => {
    const eligible = targets.filter(
      (t) => t.status && (key !== "connect" || t.status.connect !== "unavailable"),
    );
    if (key === "connect" && eligible.length === 0) return null;
    const anyOn = eligible.some((t) => t.status?.preferences[key]);
    const mixed = anyOn && eligible.some((t) => !t.status?.preferences[key]);
    const states = eligible.flatMap(({ env, status, blockedByDesktop }) => {
      if (!status) return [];
      const state =
        key === "enabled"
          ? summary(status)
          : key === "connect" && blockedByDesktop
            ? gt("Blocked by desktop settings")
            : status[key] === "sdk" && status.sdkDisabledBy
              ? gt("Disabled by {variable}", { variable: status.sdkDisabledBy })
              : m(reasons[status[key]]);
      return [eligible.length === 1 ? state : `${env.label} · ${state}`];
    });
    return (
      <label key={key} className="flex items-center justify-between gap-4 py-2">
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">{label}</span>
          {states.map((state) => (
            <span key={state} className="text-xs text-muted-foreground">
              {state}
            </span>
          ))}
        </span>
        <Switch
          size="sm"
          aria-label={label}
          checked={anyOn}
          mixed={mixed}
          disabled={saving || !eligible.some((t) => !t.issue)}
          onCheckedChange={() => void write(key, !anyOn)}
        />
      </label>
    );
  };

  return (
    <SettingsSection title={gt("Send telemetry")} hideTitle id="telemetry-export">
      <div className="px-4 py-2 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4">
          <div className="min-w-48 flex-1">{row("enabled", gt("Send telemetry"))}</div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-expanded={expanded}
            aria-controls="telemetry-channels"
            onClick={() => setExpanded(!expanded)}
          >
            {gt("What to send")}
          </Button>
        </div>
        {expanded && (
          <div id="telemetry-channels" className="border-t border-border/60">
            {row("analytics", m(channels.analytics))}
            {row("connect", m(channels.connect))}
            {row("otlp", m(channels.otlp))}
            {scope.kind === "environment" && targets[0]?.status ? (
              <TelemetryExportSettings />
            ) : (
              <p className="py-2 text-xs text-muted-foreground">
                {gt("Choose one environment to configure its telemetry exports.")}
              </p>
            )}
          </div>
        )}
        <div role="status" className="text-xs text-muted-foreground">
          {targets.map(({ env, issue }) => {
            const outcome = issue ?? report.get(env.environmentId);
            return outcome ? (
              <p key={env.environmentId}>
                {env.label} · {m(outcomes[outcome])}
              </p>
            ) : null;
          })}
        </div>
      </div>
    </SettingsSection>
  );
}
