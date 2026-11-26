import type { ComposerModelMentionEffort } from "@t3tools/client-runtime/composer-model-mentions";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createContext, type MouseEvent } from "react";

/** A model mention chip whose effort the user wants to change; `apply` rewrites that chip. */
export interface ComposerModelEffortEditRequest {
  readonly instanceId: string;
  readonly model: string;
  readonly effort: ComposerModelMentionEffort | null;
  readonly apply: (source: string, effort: ComposerModelMentionEffort | null) => boolean;
}

export interface ComposerContextActions {
  environmentId: EnvironmentId | null;
  cwd?: string | undefined;
  projectId?: ProjectId | undefined;
  expandImage: (imageId: string) => void;
  expandVideo: (fileId: string) => void;
  openFile: (fileId: string) => void;
  openMention: (path: string) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  editModelEffort?: ((request: ComposerModelEffortEditRequest) => void) | undefined;
}

export const ComposerContextActionsContext = createContext<ComposerContextActions>({
  environmentId: null,
  expandImage: () => {},
  expandVideo: () => {},
  openFile: () => {},
  openMention: () => {},
  openPullRequest: () => {},
});
