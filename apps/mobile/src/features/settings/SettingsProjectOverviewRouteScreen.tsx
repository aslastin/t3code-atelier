import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { T, useGT } from "gt-react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { Button } from "../../components/ui/Button";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import * as Dialog from "../../components/ui/Dialog";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  planProjectRemoval,
  differentRepositoryFoldersNotice,
  projectRemovalNotice,
  removalEntryDetail,
  removeEntriesLabel,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveProjectGroupLabel,
  type ProjectGroup,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { projectEnvironment } from "../../state/projects";
import { useThreadShells } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  clearComposerDraft,
  composerDraftsAtom,
  findNewTaskDraftKeys,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ProjectRepositoriesSection } from "./ProjectRepositoriesSection";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { leaveSettingsPage } from "./settings-navigation";
import { workspaceHasColumns } from "../layout/workspace/workspace-selection-store";
import { DEFAULT_SETTINGS_PAGE } from "../layout/workspace/workspace-tab-navigation";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { m } from "../../i18n/messages";

export function SettingsProjectOverviewRouteScreen() {
  const gt = useGT();
  const environmentMenu = useSettingsEnvironmentMenu();
  const insets = useSafeAreaInsets();
  const [isRemoving, setIsRemoving] = useState(false);
  const removalPending = useRef(false);
  const startRemoval = () => {
    if (removalPending.current) return false;
    removalPending.current = true;
    return true;
  };
  const finishRemoval = () => {
    removalPending.current = false;
    setIsRemoving(false);
  };
  const navigation = useNavigation();
  const {
    availableTargets,
    selectedTargets,
    projectGroups,
    selectedProjectKey,
    selectProject,
    getSelectedProjectKey,
  } = useSettingsEnvironmentFilter();
  // The filter can move to another project while a removal is still running.
  const finishProjectRemoval = (projectKey: string | null) => {
    if (getSelectedProjectKey() !== projectKey) return;
    if (navigation.isFocused())
      leaveSettingsPage(navigation, workspaceHasColumns(), DEFAULT_SETTINGS_PAGE);
    // Otherwise the filter keeps pointing at the removed project as an unavailable one.
    selectProject(null);
  };
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const selectedEnvironmentIds = new Set(selectedTargets.map((entry) => entry.environmentId));
  const members =
    group?.members
      .map((entry) => entry.project)
      .filter((project) => selectedEnvironmentIds.has(project.environmentId)) ?? [];

  return (
    <SettingsScreen title={gt("Projects")} menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedProjectKey === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            <T>Choose a project with the filter above to manage its name, checkouts and removal.</T>
          </Text>
        ) : !group || members.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            <T>
              This project has no checkout on the selected connected environments. Change the filter
              above.
            </T>
          </Text>
        ) : (
          <ProjectOverviewContent
            key={`${selectedProjectKey}:${members.map((member) => member.id).join(",")}`}
            members={members}
            group={group}
            projectGroups={projectGroups}
            connectedTargets={availableTargets}
            environments={selectedTargets}
            hasOtherMembers={members.length < (group?.members.length ?? 0)}
            isRemoving={isRemoving}
            setIsRemoving={setIsRemoving}
            startRemoval={startRemoval}
            finishRemoval={finishRemoval}
            projectKey={selectedProjectKey}
            onProjectRemoved={finishProjectRemoval}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function ProjectOverviewContent(props: {
  readonly members: readonly EnvironmentProject[];
  /** Pin and archive belong to the whole project, even when the filter picks one machine. */
  readonly group: ProjectGroup;
  readonly projectGroups: readonly ProjectGroup[];
  readonly connectedTargets: readonly SettingsTarget[];
  readonly environments: readonly SettingsTarget[];
  readonly hasOtherMembers: boolean;
  readonly isRemoving: boolean;
  readonly setIsRemoving: (isRemoving: boolean) => void;
  readonly startRemoval: () => boolean;
  readonly finishRemoval: () => void;
  readonly projectKey: string | null;
  readonly onProjectRemoved: (projectKey: string | null) => void;
}) {
  const gt = useGT();
  const { isRemoving, setIsRemoving, startRemoval, finishRemoval } = props;
  const representative = props.members[0]!;
  const displayName = deriveProjectGroupLabel({
    groupKey: props.group.key,
    representative,
    members: props.members,
  });
  const [draftName, setDraftName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const threads = useThreadShells();
  const allMembers = props.group.members.map((member) => member.project);
  const removableEnvironments = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const canRemoveGroup = props.members.every((member) =>
    removableEnvironments.has(member.environmentId),
  );
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project name update",
    reportFailure: true,
  });
  const organizeProject = useAtomCommand(projectEnvironment.update, {
    label: "project update",
    reportFailure: true,
  });
  const [isOrganizing, setIsOrganizing] = useState(false);
  const memberTargets = allMembers.map((member) =>
    props.connectedTargets.find((entry) => entry.environmentId === member.environmentId),
  );
  const offline = memberTargets.some((target) => target === undefined);
  // Older servers drop pin and archive, so their projects do not offer them.
  // Offline members are checked when the write runs, so their reason can show.
  const canOrganize =
    allMembers.every(
      (member, index) =>
        memberTargets[index] === undefined || removableEnvironments.has(member.environmentId),
    ) &&
    memberTargets.every(
      (target) =>
        target === undefined ||
        target.serverConfig.environment.capabilities.projectOrganization === true,
    );
  // One machine at a time, stopping at the first failure, as web does.
  const organize = async (input: { readonly pinned?: boolean; readonly archived?: boolean }) => {
    setIsOrganizing(true);
    for (const member of allMembers) {
      if (!readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope)) {
        Dialog.alert(
          gt("Failed to update project"),
          gt("This connection can no longer change it."),
        );
        break;
      }
      const result = await organizeProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, ...input },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(
            gt('Failed to update "{project}"', { project: member.title }),
            error instanceof Error
              ? (errorDisplayMessage(error, m) ?? error.message)
              : gt("An error occurred."),
          );
        }
        break;
      }
    }
    setIsOrganizing(false);
  };
  const nextName = (draftName ?? displayName).trim();
  const canSave = !isSaving && nextName.length > 0 && nextName !== displayName;

  const checkRemovalAccess = (members: readonly EnvironmentProject[]) => {
    const denied = members.find(
      (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
    );
    if (!denied) return true;
    const environment = props.environments.find(
      (entry) => entry.environmentId === denied.environmentId,
    );
    Dialog.alert(
      gt("Failed to remove project"),
      environment
        ? gt("This connection cannot change projects in {environment}.", {
            environment: environment.label,
          })
        : gt("This connection cannot change projects in this environment."),
    );
    return false;
  };

  type RemovalPlan = ReturnType<
    typeof planProjectRemoval<EnvironmentProject, EnvironmentThreadShell>
  >;
  const [removal, setRemoval] = useState<RemovalPlan | null>(null);
  const [includeNested, setIncludeNested] = useState(false);
  const reviewRemoval = (members: readonly EnvironmentProject[]) => {
    if (isRemoving || !checkRemovalAccess(members)) return;
    setIncludeNested(false);
    setRemoval(
      planProjectRemoval({
        members,
        groupMembers: allMembers,
        projects: props.projectGroups.flatMap((entry) =>
          entry.members.map(({ project }) => project),
        ),
        threads,
        unloadedThreadCount: (member, held) => readUnloadedThreadCount([member], held),
      }),
    );
  };
  const removeEntries = async (entries: RemovalPlan["entries"]) => {
    const members = entries.map((entry) => entry.member);
    const projectKey = props.projectKey;
    if (!checkRemovalAccess(members)) return;
    for (const member of members) {
      if (!checkRemovalAccess([member])) return;
      const result = await deleteProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, force: true },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(
            gt('Failed to remove "{project}"', { project: member.title }),
            error instanceof Error
              ? (errorDisplayMessage(error, m) ?? error.message)
              : gt("An error occurred."),
          );
        }
        return;
      }
      await waitForComposerDraftsLoaded()
        .then(() => {
          for (const draftKey of findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), {
            environmentId: member.environmentId,
            projectId: member.id,
          })) {
            clearComposerDraft(draftKey);
          }
        })
        .catch((error) => {
          console.warn("[project-removal] could not clear composer drafts", error);
        });
    }
    if (
      allMembers.every((candidate) =>
        members.some(
          (member) =>
            member.environmentId === candidate.environmentId && member.id === candidate.id,
        ),
      )
    ) {
      props.onProjectRemoved(projectKey);
    }
  };
  const selectedEntries = removal?.entriesToRemove(includeNested) ?? [];
  const confirmRemoval = () => {
    if (!startRemoval()) return;
    setRemoval(null);
    setIsRemoving(true);
    void removeEntries(selectedEntries).finally(finishRemoval);
  };
  const removalRows = (entries: RemovalPlan["entries"]) =>
    entries.map(({ member, threadCount }) => (
      <View key={`${member.environmentId}:${member.id}`}>
        <Text className="text-base text-foreground" selectable>
          {member.workspaceRoot}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {m(
            removalEntryDetail(
              props.environments.find((target) => target.environmentId === member.environmentId)
                ?.label ?? member.environmentId,
              threadCount,
            ),
          )}
        </Text>
      </View>
    ));

  const saveName = () => {
    if (!canSave) return;
    setIsSaving(true);
    void (async () => {
      const results = await Promise.all(
        props.members.map((member) =>
          updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, title: nextName },
          }),
        ),
      );
      setIsSaving(false);
      if (results.every((result) => result._tag !== "Failure")) setDraftName(null);
    })();
  };

  return (
    <>
      <View className="flex-row items-center gap-4 px-2">
        <ProjectFavicon
          environmentId={representative.environmentId}
          projectTitle={representative.title}
          workspaceRoot={representative.workspaceRoot}
          faviconPath={representative.faviconPath}
          projectIcon={representative.projectIcon}
          size={48}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-semibold text-foreground" numberOfLines={2}>
            {displayName}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {gt("{count, plural, one {{count} checkout} other {{count} checkouts}}", {
              count: props.members.length,
            })}
          </Text>
        </View>
      </View>

      <SettingsSection title={gt("Project")}>
        <View className="gap-3 p-4">
          <Text className="text-sm font-t3-medium text-foreground-muted">
            <T>Name</T>
          </Text>
          <View className="flex-row items-center gap-3">
            <AppTextInput
              accessibilityLabel={gt("Project name")}
              className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              value={draftName ?? displayName}
              onChangeText={setDraftName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              editable={!isSaving}
            />
            {canSave ? (
              <Button
                label={gt("Save")}
                accessibilityHint={gt("Save project name")}
                tone="secondary"
                onPress={saveName}
              />
            ) : null}
          </View>
        </View>
      </SettingsSection>

      {canOrganize ? (
        <SettingsSection title={gt("Organize")}>
          <SettingsSwitchRow
            icon="pin"
            label={gt("Pin", { $context: "verb, keep the project at the top" })}
            subtitle={
              offline
                ? gt("Connect every machine with this project to change this.")
                : gt("Pinned projects come first in project pickers.")
            }
            value={props.group.pinned}
            disabled={isOrganizing || offline}
            onValueChange={(pinned) => void organize({ pinned })}
          />
          <SettingsActionRow
            icon="archivebox"
            label={props.group.archived ? gt("Unarchive project") : gt("Archive project")}
            description={
              props.group.archived
                ? gt("Hidden from project pickers. Threads and files are kept.")
                : gt("Hides the project from project pickers. Threads and files are kept.")
            }
            disabled={isOrganizing || offline}
            onPress={() => void organize({ archived: !props.group.archived })}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title={gt("Checkouts")}>
        {props.members.map((member, index) => {
          const environment = props.environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          return (
            <View
              key={`${member.environmentId}:${member.id}`}
              className={index === 0 ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}
            >
              <Text
                className={
                  Platform.OS === "android"
                    ? "text-base text-foreground"
                    : "text-lg text-foreground"
                }
              >
                {environment?.label ?? gt("Environment")}
              </Text>
              {environment?.displayUrl ? (
                <Text className="text-sm leading-normal text-foreground-muted">
                  {environment.displayUrl}
                </Text>
              ) : null}
              <Text className="text-sm leading-normal text-foreground-muted" selectable>
                {member.workspaceRoot}
              </Text>
              {props.members.length > 1 || props.hasOtherMembers ? (
                <RemoveCheckoutAction
                  member={member}
                  disabled={isRemoving}
                  onPress={() => reviewRemoval([member])}
                />
              ) : null}
            </View>
          );
        })}
      </SettingsSection>
      {props.members.map((member) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === member.environmentId,
        )?.label;
        return (
          <ProjectRepositoriesSection
            key={`${member.environmentId}:${member.id}`}
            member={member}
            title={
              props.members.length === 1
                ? gt("Repositories")
                : gt("Repositories · {environment}", {
                    environment: environment ?? gt("Environment"),
                  })
            }
          />
        );
      })}
      <SettingsSection
        title={gt("Danger", { $context: "section heading for destructive actions" })}
      >
        <SettingsActionRow
          icon="trash"
          label={
            props.members.length > 1
              ? gt("Review entries")
              : props.hasOtherMembers
                ? gt("Remove checkout")
                : gt("Remove project")
          }
          description={gt("Review the folders and threads to remove.")}
          tone="danger"
          disabled={!canRemoveGroup || isRemoving}
          loading={isRemoving}
          onPress={() => reviewRemoval(props.members)}
        />
      </SettingsSection>
      {removal && (
        <Sheet title={gt("Remove project entries")} onClose={() => setRemoval(null)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-4 p-5 pb-10"
          >
            <Text className="text-base text-foreground-muted">{m(projectRemovalNotice)}</Text>
            {removal.differentRepositoryFolders && (
              <Text className="text-base text-foreground">
                {m(differentRepositoryFoldersNotice)}
              </Text>
            )}
            {removalRows(removal.entries)}
            {removal.nestedEntries.length > 0 && (
              <>
                <SettingsSwitchRow
                  icon="folder"
                  label={gt("Also remove nested projects")}
                  value={includeNested}
                  onValueChange={setIncludeNested}
                />
                {removalRows(removal.nestedEntries)}
              </>
            )}
            <Button
              fullWidth
              tone="danger"
              label={m(removeEntriesLabel(selectedEntries.length))}
              onPress={confirmRemoval}
            />
            <Button fullWidth label={gt("Cancel")} onPress={() => setRemoval(null)} />
          </ScrollView>
        </Sheet>
      )}
    </>
  );
}

function RemoveCheckoutAction(props: {
  readonly member: EnvironmentProject;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const canRemove = useEnvironmentScope(props.member.environmentId, AuthOrchestrationOperateScope);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Remove checkout {path}", { path: props.member.workspaceRoot })}
      disabled={props.disabled || !canRemove}
      onPress={props.onPress}
      className="self-start rounded-full border border-border bg-card px-3 py-1.5 disabled:opacity-40"
    >
      <Text className="font-t3-medium text-xs text-danger-foreground">
        <T>Remove checkout</T>
      </Text>
    </Pressable>
  );
}
