// Atelier fork: separate drafts within one project, such as a topic's. A slot's draft key is
// `<project key>\0<slot>`. Project keys are paths or repository ids, which never hold NUL, so a
// slot key never equals another project's key.
const SLOT_SEPARATOR = "\u0000";

export function draftSlotKey(projectKey: string, slot: string | undefined): string {
  return slot === undefined ? projectKey : `${projectKey}${SLOT_SEPARATOR}${slot}`;
}

/** The slot a draft key names, or null for a project's own draft. */
export function draftSlotOf(draftKey: string): string | null {
  const index = draftKey.indexOf(SLOT_SEPARATOR);
  return index === -1 ? null : draftKey.slice(index + 1);
}

/** Whether `draftKey` is one of `projectKey`'s slots. */
export function isDraftSlotOf(draftKey: string, projectKey: string): boolean {
  return draftKey.startsWith(`${projectKey}${SLOT_SEPARATOR}`);
}
