import { render } from "../../../test/render";
import { DEFAULT_SERVER_SETTINGS, type ServerObservability } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { state, updateSettings, checkOtlpEndpoint, checkOtlpEndpointCommand } = vi.hoisted(() => ({
  state: {
    listeners: new Set<() => void>(),
    observability: {} as typeof DEFAULT_SERVER_SETTINGS.observability,
    serverConfig: { environment: { capabilities: {} } } as {
      environment: { capabilities: { otlpEndpointCheck?: boolean } };
      observability?: ServerObservability;
    },
  },
  updateSettings: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
  checkOtlpEndpoint: vi.fn(async (_request: unknown) => ({
    _tag: "Success" as const,
    value: { _tag: "Accepted" as const, latencyMs: 12 },
  })),
  checkOtlpEndpointCommand: { permissionAtom: () => null },
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "updateSettings"
      ? updateSettings
      : command === checkOtlpEndpointCommand
        ? checkOtlpEndpoint
        : vi.fn()) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
      checkOtlpEndpoint: checkOtlpEndpointCommand,
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("./SettingsScopeContext"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  return {
    ...(await original()),
    useSettingsScope: (() => {
      const running = useSyncExternalStore(subscribe, () => state.serverConfig.observability);
      return {
        scope: { kind: "environment" },
        environment: {
          environmentId: "env",
          label: "MAC1",
          serverConfig: { ...state.serverConfig, observability: running },
        },
      };
    }) as never,
  };
});
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select: (settings: typeof state) => unknown) => select(state)) as never,
}));

import { TelemetryExportSettings } from "./TelemetryExportSettings";

const activeExport: ServerObservability = {
  localTracingEnabled: true,
  logsDirectoryPath: "/tmp/logs",
  otlpMetricsEnabled: false,
  otlpLogsEnabled: false,
  otlpTracesEnabled: true,
  telemetry: {
    preferences: { enabled: true, analytics: false, connect: false, otlp: true },
    analytics: "off",
    connect: "unavailable",
    otlp: "on",
  },
};
function setup() {
  updateSettings.mockClear();
  checkOtlpEndpoint.mockReset();
  state.serverConfig = { environment: { capabilities: {} } };
}

describe("TelemetryExportSettings", () => {
  it("does not resend a field the user restored after another client changed it", async () => {
    setup();
    state.observability = {
      ...DEFAULT_SERVER_SETTINGS.observability,
      otlpTracesUrl: "http://old/v1/traces",
    };
    await using screen = await render(<TelemetryExportSettings />);

    const { container } = screen;
    const field = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
    async function replace(id: string, value: string) {
      await userEvent.clear(field(id));
      await userEvent.type(field(id), value);
    }
    await replace("otlpTracesUrl", "http://draft/v1/traces");
    await replace("otlpTracesUrl", "http://old/v1/traces");
    state.observability = { ...state.observability, otlpTracesUrl: "http://other/v1/traces" };
    await screen.rerender(<TelemetryExportSettings />);
    await replace("otlpMetricsUrl", "http://new/v1/metrics");
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await userEvent.click(save);

    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { patch: { observability: { otlpMetricsUrl: "http://new/v1/metrics" } } },
    });
    expect(container.textContent).toContain("Saved");
  });

  it("reports and tests the endpoint the environment set over an empty setting", async () => {
    setup();
    state.observability = { ...DEFAULT_SERVER_SETTINGS.observability, otlpTracesUrl: "" };
    state.serverConfig = {
      environment: { capabilities: { otlpEndpointCheck: true } },
      observability: {
        ...activeExport,
        logsDirectoryPath: "/tmp/logs",
        localTracingEnabled: true,
        otlpTracesUrl: "http://collector/v1/traces",
        otlpTracesSource: "environment",
        otlpTracesVariable: "OTEL_EXPORTER_OTLP_ENDPOINT",
        otlpTracesEnabled: true,
        otlpMetricsEnabled: false,
        otlpLogsEnabled: false,
      },
    };
    await using screen = await render(<TelemetryExportSettings />);

    await expect
      .element(screen.getByText("Set by environment · Connected · 12 ms"))
      .toBeInTheDocument();
    await expect
      .element(
        screen.getByText("Running: http://collector/v1/traces from OTEL_EXPORTER_OTLP_ENDPOINT"),
      )
      .toBeInTheDocument();
    expect(checkOtlpEndpoint).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { signal: "traces", url: "http://collector/v1/traces" },
    });
    expect(screen.container.querySelector<HTMLInputElement>("#otlpTracesUrl")!.value).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Test" }).first());

    expect(checkOtlpEndpoint).toHaveBeenCalledTimes(2);
    expect(checkOtlpEndpoint).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { signal: "traces", url: "http://collector/v1/traces" },
    });
  });

  it("checks the current saved endpoint when permission returns and discards pending manual probes", async () => {
    setup();
    const oldUrl = "http://old/v1/traces";
    const newUrl = "http://new/v1/traces";
    const manualUrl = "http://draft/v1/traces";
    state.observability = { ...DEFAULT_SERVER_SETTINGS.observability, otlpTracesUrl: oldUrl };
    const disabled = {
      ...activeExport,
      telemetry: { ...activeExport.telemetry!, otlp: "off" as const },
    };
    state.serverConfig = {
      environment: { capabilities: { otlpEndpointCheck: true } },
      observability: disabled,
    };
    await using screen = await render(<TelemetryExportSettings />);
    expect(checkOtlpEndpoint).not.toHaveBeenCalled();
    state.observability = { ...state.observability, otlpTracesUrl: newUrl };
    state.serverConfig.observability = activeExport;
    for (const listener of state.listeners) listener();
    await screen.rerender(<TelemetryExportSettings />);
    await expect.element(screen.getByText("Connected · 12 ms")).toBeInTheDocument();
    expect(checkOtlpEndpoint).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { signal: "traces", url: newUrl },
    });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof checkOtlpEndpoint>>>();
    checkOtlpEndpoint.mockReturnValueOnce(pending.promise);
    await userEvent.fill(screen.getByRole("textbox", { name: "Traces endpoint" }), manualUrl);
    await userEvent.click(screen.getByRole("button", { name: "Test" }).first());
    state.serverConfig.observability = disabled;
    for (const listener of state.listeners) listener();
    await screen.rerender(<TelemetryExportSettings />);
    state.serverConfig.observability = activeExport;
    for (const listener of state.listeners) listener();
    await screen.rerender(<TelemetryExportSettings />);
    pending.resolve({ _tag: "Success", value: { _tag: "Accepted", latencyMs: 800 } });
    expect(checkOtlpEndpoint.mock.calls.map(([request]) => request)).toEqual(
      [newUrl, manualUrl, newUrl].map((url) => ({
        environmentId: "env",
        input: { signal: "traces", url },
      })),
    );
  });

  it("can test a corrected URL and reports only the latest attempt when a URL is reused", async () => {
    setup();
    state.observability = { ...DEFAULT_SERVER_SETTINGS.observability, otlpTracesUrl: "" };
    state.serverConfig = {
      environment: { capabilities: { otlpEndpointCheck: true } },
      observability: activeExport,
    };
    const first = Promise.withResolvers<Awaited<ReturnType<typeof checkOtlpEndpoint>>>();
    const corrected = Promise.withResolvers<Awaited<ReturnType<typeof checkOtlpEndpoint>>>();
    const latest = Promise.withResolvers<Awaited<ReturnType<typeof checkOtlpEndpoint>>>();
    checkOtlpEndpoint
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(corrected.promise)
      .mockReturnValueOnce(latest.promise);
    await using screen = await render(<TelemetryExportSettings />);

    const traces = screen.getByRole("textbox", { name: "Traces endpoint" });
    const testTraces = screen.getByRole("button", { name: "Test" }).first();
    await userEvent.fill(traces, "http://first/v1/traces");
    await userEvent.click(testTraces);
    await expect.element(testTraces).toBeDisabled();

    await userEvent.fill(traces, "http://corrected/v1/traces");
    await expect.element(testTraces).toBeEnabled();
    await userEvent.click(testTraces);
    await expect.element(testTraces).toBeDisabled();

    await userEvent.fill(traces, "http://first/v1/traces");
    await userEvent.click(testTraces);
    await expect.element(testTraces).toBeDisabled();

    corrected.resolve({ _tag: "Success", value: { _tag: "Accepted", latencyMs: 22 } });
    first.resolve({ _tag: "Success", value: { _tag: "Accepted", latencyMs: 11 } });
    latest.resolve({ _tag: "Success", value: { _tag: "Accepted", latencyMs: 33 } });

    await expect.element(screen.getByText("Connected · 33 ms")).toBeInTheDocument();
  });
});
