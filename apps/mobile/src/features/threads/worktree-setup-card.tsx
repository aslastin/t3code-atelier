import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, WorktreeFolderChoice } from "@t3tools/contracts";
import { FormField } from "../../components/ui/FormSection";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { msg, T, useGT, useMessages } from "gt-react-native";

import type { MessageResolver } from "../../i18n/messages";

import { Button } from "../../components/ui/Button";
import {
  WORKTREE_SETUP_STAGE_ORDER,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@t3tools/contracts";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Sheet } from "../../components/ui/Sheet";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";

export interface WorktreeSetupCardProps {
  environmentId?: EnvironmentId;
  snapshot: WorktreeSetupSnapshot;
  turnStarted: boolean;
  onCancel: () => void;
  onWorkLocally: (() => void) | null;
}

function elapsed(start: string | null, end: string | null, now: number, resolve: MessageResolver) {
  const duration = (end ? Date.parse(end) : now) - (start ? Date.parse(start) : NaN);
  return Number.isFinite(duration) ? formatDuration(Math.max(0, duration), resolve) : null;
}

const statusLabels = {
  pending: msg("pending", { $context: "setup stage status" }),
  running: msg("running", { $context: "setup stage status" }),
  done: msg("done", { $context: "setup stage status" }),
  skipped: msg("skipped", { $context: "setup stage status" }),
  failed: msg("failed", { $context: "setup stage status" }),
  warning: msg("warning", { $context: "setup stage status" }),
} as const satisfies Record<WorktreeSetupStage["status"], string>;

const stageLabels = {
  fetch: msg("Fetch base branch"),
  checkout: msg("Check out files"),
  submodules: msg("Init submodules"),
  "setup-script": msg("Run setup script"),
  agent: msg("Start agent"),
} as const satisfies Record<WorktreeSetupStage["id"], string>;

const icons: Record<WorktreeSetupStage["status"], AppSymbolName> = {
  pending: "circle",
  running: "clock",
  done: "checkmark",
  skipped: "minus",
  failed: "xmark",
  warning: "exclamationmark.triangle",
};

/** The feed owns whether the details sheet is open, so it survives the card turning into a chip or summary. */
interface SetupDetailsControl {
  readonly detailsOpen: boolean;
  readonly onOpenDetails: () => void;
}

export function WorktreeSetupCard(props: WorktreeSetupCardProps & SetupDetailsControl) {
  // Once the agent has the turn, running setup is a chip on the live Working row.
  if (worktreeSetupHandedOff(props)) {
    // As on web, only a setup that went wrong stays in view.
    return setupWentWrong(props.snapshot) ? <WorktreeSetupSummaryRow {...props} /> : null;
  }
  return <WorktreeSetupHeaderCard {...props} />;
}

function MissingProjectFolder({
  snapshot,
  environmentId,
  onCancel,
}: {
  snapshot: WorktreeSetupSnapshot;
  environmentId: EnvironmentId;
  onCancel: () => void;
}) {
  const gt = useGT();
  const allowed = useAtomValue(vcsEnvironment.chooseWorktreeFolder.permissionAtom(environmentId));
  const choose = useAtomCommand(vcsEnvironment.chooseWorktreeFolder);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const branches = usePaginatedBranches({
    environmentId,
    cwd: open ? snapshot.worktreePath : null,
    query: useDebouncedValue(query, 180),
  });
  const request = snapshot.folderChoice;
  if (!request) return null;
  const respond = async (choice: WorktreeFolderChoice) => {
    setBusy(true);
    await choose({
      environmentId,
      input: { threadId: snapshot.threadId, requestId: request.requestId, choice },
    }).finally(() => setBusy(false));
  };
  return (
    <View className="my-2 gap-2 rounded-lg border border-warning-border bg-card-alt p-3">
      <Text className="font-semibold text-warning-foreground">
        <T>Project folder missing</T>
      </Text>
      <Text>
        {gt(
          "This checkout of {branch} does not contain {folder}. Choose another base branch, or run the setup script and agent from the worktree root.",
          { branch: snapshot.baseRef ?? "HEAD", folder: request.relativePath },
        )}
      </Text>
      <Text selectable className="text-xs text-foreground-secondary">
        <T>Worktree root</T> · {snapshot.worktreePath}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Choose another branch")}
          disabled={!allowed || busy}
          onPress={() => setOpen(true)}
        />
        <Button
          label={gt("Use worktree root")}
          tone="secondary"
          disabled={!allowed || busy}
          onPress={() => void respond({ type: "root" })}
        />
        <Button label={gt("Cancel")} tone="text" disabled={busy} onPress={onCancel} />
      </View>
      {open && (
        <Sheet title={gt("Choose another branch")} onClose={() => setOpen(false)}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 16, gap: 8 }}
          >
            <FormField
              label={gt("Find a branch")}
              accessibilityLabel={gt("Find a branch")}
              placeholder={gt("Find a branch")}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {branches.refs.map((ref) => (
              <ListChoiceRow
                key={ref.name}
                label={ref.name}
                selected={ref.name === snapshot.baseRef}
                disabled={
                  busy || !allowed || ref.name === snapshot.baseRef || ref.name === snapshot.branch
                }
                onPress={() => void respond({ type: "branch", baseRef: ref.name })}
              />
            ))}
            {branches.error ? (
              <Text>{branches.error}</Text>
            ) : (
              branches.refs.length === 0 && (
                <Text>
                  {branches.isPending ? gt("Loading branches…") : gt("No matching branches")}
                </Text>
              )
            )}
            {branches.data?.nextCursor != null && (
              <Button
                tone="secondary"
                label={gt("Load more")}
                disabled={branches.isFetchingNextPage}
                onPress={branches.loadNext}
              />
            )}
          </ScrollView>
        </Sheet>
      )}
    </View>
  );
}

function WorktreeSetupHeaderCard(props: WorktreeSetupCardProps & SetupDetailsControl) {
  const { snapshot, detailsOpen } = props;
  const gt = useGT();
  const messages = useMessages();
  const running = snapshot.phase === "running";
  const now = useVisibleSecondClock(running && !snapshot.folderChoice);
  const failed =
    snapshot.phase === "failed" || snapshot.stages.some((stage) => stage.status === "failed");
  const label = snapshot.folderChoice
    ? gt("Worktree setup paused")
    : running
      ? gt("Setting up worktree…")
      : snapshot.phase === "cancelled"
        ? gt("Worktree setup cancelled")
        : snapshot.phase === "failed"
          ? gt("Worktree setup failed")
          : failed
            ? gt("Setup script failed")
            : gt("Worktree ready");

  return (
    <View accessibilityLabel={gt("Worktree setup")} className="py-1">
      <View className="min-h-11 flex-row items-center gap-2 border-b border-border px-1">
        <HeaderLabel
          label={label}
          active={running && !detailsOpen && !snapshot.folderChoice}
          failed={failed}
        />
        <Text
          className="text-2xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {elapsed(snapshot.startedAt, snapshot.endedAt, now, messages)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Worktree setup details")}
          accessibilityState={{ expanded: detailsOpen }}
          onPress={props.onOpenDetails}
          className="min-h-11 max-w-[55%] justify-center px-2"
        >
          <View className="flex-row items-center gap-1">
            {failed ? (
              <SymbolView
                name="exclamationmark.circle"
                size={12}
                tintColorClassName="accent-danger-foreground"
              />
            ) : null}
            <Text numberOfLines={1} className="shrink text-2xs text-foreground-secondary">
              <T>Details</T>
            </Text>
            <SymbolView name="chevron.right" size={10} tintColorClassName="accent-icon-muted" />
          </View>
        </Pressable>
      </View>
      <View className="pt-1 pb-2">
        {snapshot.stages
          .filter((stage) => stage.id !== "agent")
          .map((stage) => (
            <View key={stage.id}>
              <StageRow
                stage={stage}
                scriptName={snapshot.setupScript?.name ?? null}
                now={now}
                compact
                animate={!detailsOpen}
              />
              {stage.id === "checkout" && snapshot.folderChoice && props.environmentId && (
                <MissingProjectFolder
                  key={snapshot.folderChoice.requestId}
                  snapshot={snapshot}
                  environmentId={props.environmentId}
                  onCancel={props.onCancel}
                />
              )}
            </View>
          ))}
      </View>
    </View>
  );
}

/** True once the agent has the turn; the turn's fold row then carries the setup instead of the card. */
export function worktreeSetupHandedOff(props: WorktreeSetupCardProps): boolean {
  return props.turnStarted && worktreeSetupAgentStarted(props.snapshot);
}

/** The card's state on the turn's fold row: setup still running, or a failure to look at. */
export function WorktreeSetupFoldChip(props: WorktreeSetupCardProps & SetupDetailsControl) {
  const gt = useGT();
  const scriptName = props.snapshot.setupScript?.name ?? gt("Setup script");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt(
        "Background setup is still running: {scriptName}. Show setup progress.",
        { scriptName },
      )}
      onPress={props.onOpenDetails}
      hitSlop={8}
      className="ml-2 min-w-0 max-w-[55%] flex-row items-center gap-1 rounded-full border border-border px-2 py-1 active:opacity-70"
    >
      <AppActivityIndicator
        size={Platform.OS === "android" ? 12 : "small"}
        colorClassName="accent-icon-muted"
        style={{
          width: 12,
          height: 12,
          transform: Platform.OS === "android" ? undefined : [{ scale: 0.65 }],
        }}
      />
      <Text numberOfLines={1} className="shrink text-2xs text-foreground-secondary">
        <T>Background setup</T>
      </Text>
    </Pressable>
  );
}

/**
 * Setup that ended after the agent took the turn, as one row under the prompt, like web's
 * collapsed summary. Tapping it opens the details.
 */
function setupWentWrong(snapshot: WorktreeSetupSnapshot): boolean {
  return (
    snapshot.phase === "failed" ||
    snapshot.phase === "cancelled" ||
    (snapshot.phase === "done" &&
      snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "failed"))
  );
}

function WorktreeSetupSummaryRow(props: WorktreeSetupCardProps & SetupDetailsControl) {
  const { snapshot } = props;
  const gt = useGT();
  const messages = useMessages();
  const now = useVisibleSecondClock(false);
  const label =
    snapshot.phase === "failed"
      ? gt("Worktree setup failed")
      : snapshot.phase === "cancelled"
        ? gt("Worktree setup cancelled")
        : gt("Worktree ready, setup script failed");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{label}. Show setup details.", { label })}
      onPress={props.onOpenDetails}
      className="mb-1 min-h-8 flex-row items-center px-1 active:opacity-70"
      style={{ columnGap: 8 }}
    >
      <View className="w-6 items-center">
        <SymbolView name="xmark" size={14} tintColorClassName="accent-danger-foreground" />
      </View>
      <Text numberOfLines={1} className="flex-1 text-sm text-danger-foreground">
        {label}
      </Text>
      <Text
        className="text-2xs text-foreground-secondary"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {elapsed(snapshot.startedAt, snapshot.endedAt, now, messages)}
      </Text>
      <SymbolView name="chevron.right" size={10} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

/** The one setup details sheet, opened from the card, the chip, or the summary row. */
export function WorktreeSetupDetails(
  props: WorktreeSetupCardProps & { readonly onClose: () => void },
) {
  const now = useVisibleSecondClock(props.snapshot.phase === "running");
  return <SetupDetailsSheet {...props} now={now} />;
}

/** Holds the card's place until the server publishes the first setup snapshot. */
// Same rows the first snapshot brings, so the card keeps its height when that snapshot lands.
const PREPARING_STAGES: ReadonlyArray<WorktreeSetupStage> = WORKTREE_SETUP_STAGE_ORDER.filter(
  (id) => id !== "agent",
).map((id) => ({
  id,
  status: "pending",
  startedAt: null,
  endedAt: null,
  percent: null,
  detail: null,
  tail: [],
}));

export function WorktreePreparingHeader() {
  const gt = useGT();
  return (
    <View className="py-1">
      <View className="min-h-11 flex-row items-center border-b border-border px-1">
        <HeaderLabel label={gt("Setting up worktree…")} active />
      </View>
      <View className="pt-1 pb-2">
        {PREPARING_STAGES.map((stage) => (
          <StageRow key={stage.id} stage={stage} scriptName={null} now={0} compact />
        ))}
      </View>
    </View>
  );
}

function HeaderLabel({
  label,
  active,
  failed = false,
}: {
  label: string;
  active: boolean;
  failed?: boolean;
}) {
  return active ? (
    <ShimmeringWorkContent
      icon="clock"
      iconSubtleColor="transparent"
      label={label}
      showIcon={false}
    />
  ) : (
    <Text
      numberOfLines={1}
      className={
        failed
          ? "flex-1 text-sm text-danger-foreground"
          : "flex-1 text-sm text-foreground-secondary"
      }
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {label}
    </Text>
  );
}

function SetupDetailsSheet({
  snapshot,
  turnStarted,
  onCancel,
  onWorkLocally,
  onClose,
  now,
}: WorktreeSetupCardProps & { onClose: () => void; now: number }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const canCancel = snapshot.phase === "running" && !turnStarted;
  return (
    <Sheet title={gt("Worktree setup")} onClose={onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        bounces={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {snapshot.stages
          .filter((stage) => stage.id !== "agent")
          .map((stage) => (
            <View key={stage.id}>
              <StageRow stage={stage} scriptName={snapshot.setupScript?.name ?? null} now={now} />
              {stage.id === "setup-script" &&
              (stage.status === "running" || stage.status === "failed" || stage.tail.length > 0) ? (
                <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              ) : null}
            </View>
          ))}
        {snapshot.phase === "failed" && snapshot.error ? (
          <Text selectable className="ml-8 mt-2 text-xs text-danger-foreground">
            {snapshot.error}
          </Text>
        ) : null}
        {canCancel ? (
          <View className="mt-3 flex-row items-center justify-end gap-4 border-t border-border pt-1">
            <Button
              label={gt("Cancel setup")}
              tone="danger"
              accessibilityLabel={gt("Cancel worktree setup")}
              onPress={() => {
                onClose();
                onCancel();
              }}
            />
            {onWorkLocally && !snapshot.folderChoice ? (
              <Button
                label={gt("Work locally")}
                tone="secondary"
                onPress={() => {
                  onClose();
                  onWorkLocally();
                }}
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function StageRow({
  stage,
  scriptName,
  now,
  compact = false,
  animate = true,
}: {
  stage: WorktreeSetupStage;
  scriptName: string | null;
  now: number;
  compact?: boolean;
  animate?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const label =
    stage.id === "setup-script"
      ? (scriptName ?? m(stageLabels[stage.id]))
      : m(stageLabels[stage.id]);
  const detail =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? m(statusLabels.skipped))
        : stage.id === "checkout" && stage.status === "running" && stage.percent !== null
          ? `${stage.percent}%`
          : stage.detail;
  return (
    <View
      accessibilityLabel={gt("{label}, {status}", { label, status: m(statusLabels[stage.status]) })}
      className={compact ? "min-h-8 flex-row items-center" : "min-h-11 flex-row items-center"}
      style={{ columnGap: 8, opacity: stage.status === "pending" ? 0.4 : 1 }}
    >
      <View className="w-6 items-center">
        {stage.status === "running" && animate ? (
          <AppActivityIndicator
            size="small"
            colorClassName="accent-icon-muted"
            style={{ transform: [{ scale: 0.75 }] }}
          />
        ) : (
          <SymbolView
            name={icons[stage.status]}
            size={14}
            tintColorClassName={
              stage.status === "failed"
                ? "accent-danger-foreground"
                : stage.status === "warning"
                  ? "accent-warning-foreground"
                  : "accent-icon-muted"
            }
          />
        )}
      </View>
      {stage.status === "running" && animate ? (
        <ShimmeringWorkContent
          icon="clock"
          iconSubtleColor="transparent"
          label={label}
          showIcon={false}
        />
      ) : (
        <Text
          numberOfLines={1}
          className={
            stage.status === "failed"
              ? "flex-1 text-sm text-danger-foreground"
              : "flex-1 text-sm text-foreground-secondary"
          }
        >
          {label}
        </Text>
      )}
      {detail ? (
        <Text numberOfLines={1} className="max-w-[25%] shrink text-2xs text-foreground-secondary">
          {detail}
        </Text>
      ) : null}
      {stage.status !== "pending" && stage.status !== "skipped" ? (
        <Text
          className="text-2xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {elapsed(stage.startedAt, stage.endedAt, now, m)}
        </Text>
      ) : null}
    </View>
  );
}

const OUTPUT_TAIL_SLOTS = [0, 1, 2, 3] as const;

function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  const gt = useGT();
  return (
    <View
      accessibilityLabel={gt("Setup script output")}
      className={
        failed
          ? "mb-2 ml-8 rounded-md border border-danger-border bg-danger px-3 py-2"
          : "mb-2 ml-8 rounded-md border border-border bg-card-alt px-3 py-2"
      }
    >
      {OUTPUT_TAIL_SLOTS.map((slot) => (
        <Text
          key={slot}
          selectable
          numberOfLines={1}
          className={
            failed
              ? "text-2xs leading-5 text-danger-foreground ios:font-[family-name:Menlo] android:font-mono"
              : "text-2xs leading-5 text-foreground-secondary ios:font-[family-name:Menlo] android:font-mono"
          }
        >
          {lines[lines.length - OUTPUT_TAIL_SLOTS.length + slot] || "\u00a0"}
        </Text>
      ))}
    </View>
  );
}
