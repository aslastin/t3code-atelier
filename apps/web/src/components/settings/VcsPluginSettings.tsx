import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginListResult, PluginSummary } from "@t3tools/contracts";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn, isWindowsPlatform } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { pluginEnvironment } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

// Atelier fork: VCS plugins installed on the environment, with the way in and out.

const STATUS_DOT: Record<PluginSummary["status"], string> = {
  available: "bg-success",
  checking: "bg-muted-foreground/35",
  disabled: "bg-muted-foreground/35",
  unavailable: "bg-warning",
  invalid: "bg-destructive",
};

/** Plugin SVG shown as an image, so markup in it never runs. */
function PluginIcon({ plugin }: { readonly plugin: PluginSummary }) {
  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      {plugin.iconSvg ? (
        <img
          alt=""
          className="size-4.5"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(plugin.iconSvg)}`}
        />
      ) : null}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          STATUS_DOT[plugin.status],
        )}
      />
    </span>
  );
}

function useFailureMessage() {
  const gt = useGT();
  return (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : gt("The request failed.");
  };
}

function PluginRow({
  environmentId,
  plugin,
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginSummary;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const failureMessage = useFailureMessage();
  // Failures show on the row, so no toast repeats them.
  const recheck = useAtomCommand(pluginEnvironment.recheck, {
    label: "recheck VCS plugin",
    reportFailure: false,
  });
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, {
    label: "turn a VCS plugin on or off",
    reportFailure: false,
  });
  const remove = useAtomCommand(pluginEnvironment.remove, {
    label: "remove VCS plugin",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const run = async (call: () => ReturnType<typeof recheck>) => {
    setBusy(true);
    setFailure(null);
    const result = await call();
    setBusy(false);
    if (result._tag === "Failure") setFailure(failureMessage(result));
  };

  const input = { id: plugin.id };
  const statusBadge =
    plugin.status === "unavailable" ? (
      <Badge variant="warning" size="sm">
        <T>Unavailable</T>
      </Badge>
    ) : plugin.status === "invalid" ? (
      <Badge variant="error" size="sm">
        <T>Invalid manifest</T>
      </Badge>
    ) : plugin.status === "disabled" ? (
      <Badge variant="secondary" size="sm">
        <T>Turned off</T>
      </Badge>
    ) : plugin.status === "checking" ? (
      <Badge variant="secondary" size="sm">
        <T>Checking</T>
      </Badge>
    ) : null;

  return (
    <div className="first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20">
      <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <PluginIcon plugin={plugin} />
            <span className="truncate text-sm font-medium text-foreground">{plugin.label}</span>
            {plugin.version ? (
              <code className="text-xs text-muted-foreground">{plugin.version}</code>
            ) : null}
            {statusBadge}
          </div>
          {plugin.problems.length > 0 ? (
            <ul className="space-y-0.5 text-xs leading-normal text-muted-foreground/80">
              {plugin.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs leading-normal text-muted-foreground/80">
              {plugin.checkpoints.length > 0 ? (
                <T>
                  Checkpoints: <Var>{plugin.checkpoints.join(", ")}</Var>
                </T>
              ) : (
                <T>No checkpoints: turns in its repositories cannot be diffed or rolled back.</T>
              )}
            </p>
          )}
          {plugin.uncheckpointedProjects && plugin.uncheckpointedProjects.length > 0 ? (
            <div className="flex gap-2 rounded-md border border-warning/35 bg-warning-surface px-2.5 py-2 text-xs leading-normal">
              <TriangleAlertIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-warning-foreground"
              />
              <span>
                {gt(
                  "{count, plural, one {# project is a subfolder of a {plugin} repository: {projects}.} other {# projects are subfolders of a {plugin} repository: {projects}.}} A native snapshot covers the whole repository, so their turns get no checkpoints. Add changed-files to the plugin's checkpoints.",
                  {
                    count: plugin.uncheckpointedProjects.length,
                    plugin: plugin.label,
                    projects: plugin.uncheckpointedProjects
                      .map((project) => project.title)
                      .join(", "),
                  },
                )}
              </span>
            </div>
          ) : null}
          {plugin.notes && plugin.notes.length > 0 ? (
            <ul className="space-y-0.5 text-xs leading-normal text-muted-foreground/70">
              {plugin.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          {plugin.lastError ? (
            <p className="text-xs leading-normal text-destructive">
              <T>
                Last error in <Var>{plugin.lastError.operation}</Var>:{" "}
                <Var>{plugin.lastError.message}</Var>
              </T>
            </p>
          ) : null}
          {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={!canManage || busy || !plugin.enabled}
                  onClick={() => void run(() => recheck({ environmentId, input }))}
                  aria-label={gt("Re-check {plugin}", { plugin: plugin.label })}
                >
                  {busy ? <Spinner /> : <CircleCheckIcon />}
                </Button>
              }
            />
            <TooltipPopup>
              <T>
                Check <Var>{plugin.label}</Var> again
              </T>
            </TooltipPopup>
          </Tooltip>
          <Switch
            checked={plugin.enabled}
            disabled={!canManage || busy}
            onCheckedChange={(enabled) =>
              void run(() => setEnabled({ environmentId, input: { id: plugin.id, enabled } }))
            }
            aria-label={gt("Use {plugin}", { plugin: plugin.label })}
          />
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={!canManage || busy}
            onClick={() => setConfirmingRemove(true)}
          >
            <T>Remove</T>
          </Button>
        </div>
      </div>
      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{plugin.label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its installed copy is deleted, and its repositories are no longer detected until you
                import the plugin again. Turn it off instead to keep it installed.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingRemove(false);
                void run(() => remove({ environmentId, input }));
              }}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ImportForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const failureMessage = useFailureMessage();
  const importFolder = useAtomCommand(pluginEnvironment.importFolder, {
    label: "import VCS plugin",
    reportFailure: false,
  });
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputId = `vcs-plugin-import-${environmentId}`;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  // The system picker shows this machine's folders: right only for the desktop's own server,
  // not a remote one or one in WSL, whose folders the palette browses instead.
  const picksLocally =
    environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    !(
      isWindowsPlatform(navigator.platform) &&
      environment?.serverConfig?.environment.platform.os === "linux"
    );

  const chooseFolder = async () => {
    if (!picksLocally) {
      openCommandPalette({ importVcsPluginIn: environmentId });
      return;
    }
    const initialPath = path.trim();
    const picked = await readLocalApi()
      ?.dialogs.pickFolder(initialPath === "" ? undefined : { initialPath })
      .catch(() => null);
    if (picked) setPath(picked);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const folder = path.trim();
    if (folder === "") return;
    setBusy(true);
    setFailure(null);
    const result = await importFolder({ environmentId, input: { path: folder } });
    setBusy(false);
    if (result._tag === "Success") setPath("");
    else setFailure(failureMessage(result));
  };

  return (
    <form className="space-y-1.5 px-3 py-3 sm:px-4" onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId} className="text-xs font-medium text-foreground">
        <T>Import a plugin folder from this machine</T>
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          size="sm"
          font="mono"
          className="min-w-0 flex-1"
          value={path}
          disabled={busy}
          placeholder={gt("/path/to/plugin")}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={busy}
          onClick={() => void chooseFolder()}
        >
          <T>Choose folder…</T>
        </Button>
        <Button size="sm" variant="outline" type="submit" disabled={busy || path.trim() === ""}>
          <T>Import</T>
        </Button>
      </div>
      {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
    </form>
  );
}

const EMPTY: PluginListResult = { plugins: [], directory: "" };

/** Settings → Version control: VCS plugins on one environment. */
export function VcsPluginSettings({
  environmentId,
  titleSuffix,
}: {
  readonly environmentId: EnvironmentId;
  readonly titleSuffix: string;
}) {
  const gt = useGT();
  const list = useEnvironmentQuery(
    pluginEnvironment.list({ environmentId, input: {} }),
    useMessages(),
  );
  const canManage = useAtomValue(pluginEnvironment.importFolder.permissionAtom(environmentId));
  const result = list.data ?? EMPTY;

  return (
    <SettingsSection
      title={`${gt("VCS plugins")}${titleSuffix}`}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={list.refresh}
                disabled={list.isPending}
                aria-label={gt("Refresh VCS plugins")}
              >
                <RefreshIcon refreshing={list.isPending} />
              </Button>
            }
          />
          <TooltipPopup>
            <T>Reload the list</T>
          </TooltipPopup>
        </Tooltip>
      }
    >
      {result.plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          environmentId={environmentId}
          plugin={plugin}
          canManage={canManage}
        />
      ))}
      {result.plugins.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          {list.error ?? (
            <T>
              Plugins add a version control system T3 Code does not ship. See the plugin guide for
              the manifest format.
            </T>
          )}
        </p>
      ) : null}
      {canManage ? <ImportForm environmentId={environmentId} /> : null}
    </SettingsSection>
  );
}
