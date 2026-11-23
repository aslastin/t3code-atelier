import {
  differentRepositoryFoldersNotice,
  type planProjectRemoval,
  projectRemovalNotice,
  removalEntryDetail,
  removeEntriesLabel,
} from "@t3tools/client-runtime/state/projects";
import { T, useMessages } from "gt-react";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { ThreadShell } from "../../types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

export type RemovalPlan = ReturnType<
  typeof planProjectRemoval<SidebarProjectGroupMember, ThreadShell>
>;

export function ProjectRemovalDialog({
  plan,
  onCancel,
  onConfirm,
}: {
  plan: RemovalPlan;
  onCancel: () => void;
  onConfirm: (entries: RemovalPlan["entries"]) => void;
}) {
  const m = useMessages();
  const [includeNested, setIncludeNested] = useState(false);
  const selected = plan.entriesToRemove(includeNested);
  const list = (entries: RemovalPlan["entries"]) => (
    <ul className="grid gap-2">
      {entries.map(({ member, threadCount }) => (
        <li key={member.physicalProjectKey} className="min-w-0">
          <div className="wrap-anywhere font-mono text-sm">{member.workspaceRoot}</div>
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {m(removalEntryDetail(member.environmentLabel ?? member.environmentId, threadCount))}
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Remove project entries</T>
          </AlertDialogTitle>
          <AlertDialogDescription>{m(projectRemovalNotice)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
          {plan.differentRepositoryFolders && (
            <p className="text-sm">{m(differentRepositoryFoldersNotice)}</p>
          )}
          {list(plan.entries)}
          {plan.nestedEntries.length > 0 && (
            <div className="space-y-2 border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={includeNested} onCheckedChange={setIncludeNested} />
                <T>Also remove nested projects</T>
              </label>
              <div className="ps-6">{list(plan.nestedEntries)}</div>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" data-slot="dialog-action" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button variant="destructive" onClick={() => onConfirm(selected)}>
            {m(removeEntriesLabel(selected.length))}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
