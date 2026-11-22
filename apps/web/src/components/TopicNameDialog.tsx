import { THREAD_TOPIC_TITLE_MAX_LENGTH } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

// Atelier fork: names a new topic.

type Request = { readonly resolve: (title: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestTopicName(): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(title: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(title);
}

export function TopicNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending name request with null when the host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <TopicNameDialog /> : null;
}

function TopicNameDialog() {
  const gt = useGT();
  const id = useId();
  const [title, setTitle] = useState("");
  const trimmed = title.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>New topic</T>
            </DialogTitle>
            <DialogDescription>
              <T>Topics group a project's threads in the sidebar.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={id}>
              <T>Name</T>
              <Input
                nativeInput
                id={id}
                autoFocus
                required
                maxLength={THREAD_TOPIC_TITLE_MAX_LENGTH}
                placeholder={gt("Topic name")}
                value={title}
                onChange={(event) => setTitle(event.target.value.replace(/[\r\n]/g, " "))}
              />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              <T context="verb">Create</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
