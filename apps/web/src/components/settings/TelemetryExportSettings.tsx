import { useAtomValue } from "@effect/atom-react";
import {
  resolveEnvironmentMachineKind,
  type OtlpEndpointCheckResult,
  type OtlpSignal,
  type ServerObservability,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useSettingsScope } from "./SettingsScopeContext";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSearchTarget } from "./settingsLayout";
import {
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
} from "./settingsScopeAxis";

const SIGNALS = [
  {
    key: "otlpTracesUrl",
    sourceKey: "otlpTracesSource",
    variableKey: "otlpTracesVariable",
    label: msg("Traces endpoint"),
    signal: "traces",
  },
  {
    key: "otlpMetricsUrl",
    sourceKey: "otlpMetricsSource",
    variableKey: "otlpMetricsVariable",
    label: msg("Metrics endpoint"),
    signal: "metrics",
  },
  {
    key: "otlpLogsUrl",
    sourceKey: "otlpLogsSource",
    variableKey: "otlpLogsVariable",
    label: msg("Logs endpoint"),
    signal: "logs",
  },
] as const;

type SignalDescriptor = (typeof SIGNALS)[number];
type SignalKey = SignalDescriptor["key"];

const OVERRIDE_LABELS = {
  environment: msg("Set by environment"),
  bootstrap: msg("Set by desktop"),
} as const;

function runningOverride(
  running: ServerObservability | undefined,
  { key, sourceKey, variableKey }: SignalDescriptor,
  resolve: MessageResolver = m,
) {
  const url = running?.[key];
  const source = running?.[sourceKey];
  if (source !== "environment" && source !== "bootstrap") return undefined;
  return {
    url: url ?? "",
    label: resolve(OVERRIDE_LABELS[source]),
    variable: running?.[variableKey],
  };
}

type EndpointCheck = { readonly url: string; readonly result: OtlpEndpointCheckResult | null };

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

function endpointStatus(
  url: string,
  check: EndpointCheck | undefined,
  resolve: MessageResolver = m,
) {
  if (url === "") {
    return {
      label: resolve(msg("Off", { $context: "export disabled" })),
      dot: "bg-muted-foreground/40",
    };
  }
  if (check?.url !== url) {
    return { label: resolve(msg("Not checked")), dot: "bg-muted-foreground/40" };
  }
  const { result } = check;
  if (result === null) return { label: resolve(msg("Checking…")), dot: "bg-warning" };
  switch (result._tag) {
    case "Accepted":
      return {
        label: resolve(msg("Connected · {ms} ms", { ms: Math.round(result.latencyMs) })),
        dot: "bg-success",
      };
    case "Disabled":
      return {
        label: resolve(msg("Off", { $context: "export disabled" })),
        dot: "bg-muted-foreground/40",
      };
    case "Rejected":
      return {
        label: resolve(msg("Rejected · HTTP {status}", { status: result.status })),
        dot: "bg-destructive",
      };
    case "Unreachable":
      return {
        label: result.timedOut ? resolve(msg("Timed out")) : resolve(msg("Unreachable")),
        dot: "bg-destructive",
      };
  }
}

type ExportEnvironment = EnvironmentPresentation & {
  serverConfig: NonNullable<EnvironmentPresentation["serverConfig"]>;
};

export function TelemetryExportSettings() {
  const gt = useGT();
  const { connectedEnvironments, scope } = useSettingsScope();
  const available = connectedEnvironments.filter((entry): entry is ExportEnvironment =>
    Boolean(entry.serverConfig?.observability?.telemetry),
  );
  const all = scope.kind === "all";
  return (
    <SettingsSearchTarget id="telemetry-endpoints" className="space-y-2 py-2">
      <h3 className="text-base font-semibold">{gt("OpenTelemetry export")}</h3>
      <SettingsGroup>
        {all && (
          <p className="px-4 py-3 text-center text-sm text-muted-foreground">
            {available.length > 0
              ? gt("Expand an environment to configure its OpenTelemetry receiver.")
              : gt(
                  "{title} requires a supporting environment. Connect or update an environment to continue.",
                  { title: gt("OpenTelemetry export") },
                )}
          </p>
        )}
        {available.map((environment) =>
          all ? (
            <EnvironmentExportPanel
              key={environment.environmentId}
              environment={environment}
              address={
                settingsScopeEnvironmentLabels(environment, connectedEnvironments).secondary ||
                settingsScopeEnvironmentAddress(environment)
              }
            />
          ) : (
            <TelemetryExportForm key={environment.environmentId} environment={environment} />
          ),
        )}
      </SettingsGroup>
    </SettingsSearchTarget>
  );
}

function EnvironmentExportPanel({
  environment,
  address,
}: {
  environment: ExportEnvironment;
  address: string;
}) {
  // Mount on the first expansion, then retain this environment's unsaved edits when folded.
  const [expanded, setExpanded] = useState<boolean>();
  return (
    <Collapsible open={expanded === true} onOpenChange={setExpanded}>
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <EnvironmentMachineIcon
          aria-hidden
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{environment.label}</span>
          <Tooltip>
            <TooltipTrigger
              render={<span className="block truncate text-xs text-muted-foreground" />}
            >
              {address}
            </TooltipTrigger>
            <TooltipPopup>{address}</TooltipPopup>
          </Tooltip>
        </span>
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted animate={false}>
        {expanded !== undefined && (
          <TelemetryExportForm environment={environment} active={expanded} />
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function TelemetryExportForm({
  environment,
  active = true,
}: {
  environment: ExportEnvironment;
  active?: boolean;
}) {
  const messages = useMessages();
  const gt = useGT();
  const formId = useId();
  const { environmentId, serverConfig } = environment;
  const saved = serverConfig.settings.observability;
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canEdit = useAtomValue(serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId));
  const canCheck =
    active &&
    serverConfig.observability.telemetry?.otlp === "on" &&
    canEdit &&
    serverConfig.environment.capabilities.otlpEndpointCheck === true;
  const running = serverConfig.observability;
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>({});
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };
  const changedSignals = SIGNALS.filter(({ key }) => values[key].trim() !== saved[key]);
  const changed = changedSignals.length > 0;

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, attempt: EndpointCheck) => {
    if (!canCheck) return;
    const { url } = attempt;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
    setChecks((previous) => {
      if (previous[key] !== attempt) return previous;
      const next = { ...previous };
      if (response._tag === "Success") next[key] = { url, result: response.value };
      else delete next[key];
      return next;
    });
  };

  const checkEndpoint = (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!canCheck || !isHttpUrl(url)) return;
    const attempt = { url, result: null };
    setChecks((previous) => ({ ...previous, [key]: attempt }));
    void sendCheck(key, signal, attempt);
  };

  const checkSavedEndpoints = useEffectEvent((enabled: boolean) => {
    setChecks({});
    if (enabled) {
      for (const descriptor of SIGNALS) {
        const url = runningOverride(running, descriptor)?.url ?? saved[descriptor.key];
        checkEndpoint(descriptor.key, descriptor.signal, url);
      }
    }
  });
  const checkRevision = canCheck ? (running?.telemetry?.revisions?.otlp ?? 0) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- start new probes for the currently authorized endpoints and invalidate prior replies
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- checks are responses from the environment for this consent period
    checkSavedEndpoints(checkRevision !== null);
  }, [checkRevision]);

  return (
    <form
      aria-label={environment.label}
      className="grid gap-4 px-4 py-4 sm:px-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!active || !canEdit || saving) return;
        setSaving(true);
        setMessage(null);
        const result = await updateSettings({
          environmentId,
          input: {
            patch: {
              observability: Object.fromEntries(
                changedSignals.map(({ key }) => [key, values[key]]),
              ),
            },
          },
        });
        setSaving(false);
        if (result._tag === "Success") {
          setDraft({});
          setMessage(gt("Saved"));
        }
      }}
    >
      <p className="text-xs text-muted-foreground">
        <T>
          Send traces, metrics, and logs to an OTLP HTTP receiver. Environment variables override
          these settings.
        </T>
      </p>
      {canEdit &&
        serverConfig.environment.capabilities.otlpEndpointCheck === true &&
        running?.telemetry?.otlp !== "on" && (
          <p className="text-xs text-muted-foreground">
            {gt("Endpoint tests are available when OTLP export is active.")}
          </p>
        )}
      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          {gt("This connection lacks permission to change settings on {environment}.", {
            environment: environment.label,
          })}
        </p>
      )}
      {SIGNALS.map((descriptor) => {
        const { key, label, signal } = descriptor;
        const override = runningOverride(running, descriptor, messages);
        const url = override?.url ?? values[key].trim();
        const check = canCheck ? endpointStatus(url, checks[key], messages) : null;
        const status = override
          ? {
              label: check ? `${override.label} · ${check.label}` : override.label,
              dot: check?.dot ?? "bg-muted-foreground/40",
            }
          : check;
        return (
          <div key={key} role="group" aria-label={messages(label)} className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                {status && <ConnectionStatusDot dotClassName={status.dot} />}
                <Label htmlFor={`${formId}-${key}`}>{messages(label)}</Label>
              </div>
              {status && <span className="text-xs text-muted-foreground">{status.label}</span>}
            </div>
            <div className="flex gap-2">
              <Input
                id={`${formId}-${key}`}
                size="sm"
                type="url"
                pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                title={gt("Enter an HTTP or HTTPS endpoint, or leave empty to disable export.")}
                placeholder={`http://localhost:4318/v1/${signal}`}
                value={values[key]}
                disabled={saving || !canEdit}
                onChange={(event) => {
                  const value = event.target.value;
                  // Clear restored drafts so later saves cannot overwrite another client's changes.
                  setDraft((previous) => {
                    const next = { ...previous, [key]: value };
                    if (value.trim() === saved[key]) delete next[key];
                    return next;
                  });
                  setMessage(null);
                }}
              />
              {canCheck && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    !isHttpUrl(url) || (checks[key]?.url === url && checks[key].result === null)
                  }
                  onClick={() => void checkEndpoint(key, signal, url)}
                >
                  <T>Test</T>
                </Button>
              )}
            </div>
            {(saved[key] !== (running?.[key] ?? "") || override?.variable) && (
              <p className="break-all text-xs text-muted-foreground">
                {running?.[key]
                  ? gt("Configured endpoint: {url}", { url: running[key] })
                  : messages(msg("No OTLP endpoint configured"))}
                {override?.variable && (
                  <>
                    {" "}
                    · <code className="font-mono">{override.variable}</code>
                  </>
                )}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!changed || saving || !canEdit}
            onClick={() => {
              setDraft({});
              setMessage(null);
              if (!canCheck) return;
              for (const descriptor of SIGNALS) {
                const { key, signal } = descriptor;
                if (runningOverride(running, descriptor)) continue;
                if (checks[key]?.url !== saved[key]) checkEndpoint(key, signal, saved[key]);
              }
            }}
          >
            <T>Discard</T>
          </Button>
          <Button type="submit" size="xs" disabled={!changed || saving || !canEdit}>
            {saving ? gt("Saving…") : gt("Save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
