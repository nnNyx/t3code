import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed, DEFAULT_THREAD_FEED_WINDOW_MESSAGES } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import {
  enqueueThreadOutboxMessage,
  removeThreadOutboxMessage,
  type QueuedThreadMessage,
} from "./thread-outbox";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
  useThreadOutboxMessages,
} from "./use-thread-outbox";
import {
  claimQueuedMessageDispatch,
  dispatchingQueuedMessageIdAtom,
  finishDispatchingQueuedMessage,
  useThreadOutboxDelivery,
} from "./use-thread-outbox-delivery";

export function appendToThreadComposerDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  // How many of the newest messages to materialize for the open thread. Huge
  // histories (e.g. the 1.7k-message Vale thread) build/render only this tail on
  // open; scrolling to the head widens the window a page at a time. Keyed by
  // thread so switching threads resets to the default window.
  const [feedWindowByThread, setFeedWindowByThread] = useState<Record<string, number>>({});
  const feedWindow = selectedThreadKey
    ? (feedWindowByThread[selectedThreadKey] ?? DEFAULT_THREAD_FEED_WINDOW_MESSAGES)
    : DEFAULT_THREAD_FEED_WINDOW_MESSAGES;
  const selectedThreadFeed = useMemo(
    () =>
      selectedThreadDetail ? buildThreadFeed(selectedThreadDetail, { window: feedWindow }) : [],
    [selectedThreadDetail, feedWindow],
  );
  // Guard against a mounted sentinel firing repeatedly for the same window: only
  // the first request at a given width grows it, and the wider window unmounts
  // the sentinel until the reader scrolls to the new head.
  const loadEarlierGuardRef = useRef<{ key: string | null; window: number }>({
    key: null,
    window: 0,
  });
  const onLoadEarlier = useCallback(() => {
    if (!selectedThreadKey) {
      return;
    }
    const guard = loadEarlierGuardRef.current;
    if (guard.key === selectedThreadKey && guard.window === feedWindow) {
      return;
    }
    loadEarlierGuardRef.current = { key: selectedThreadKey, window: feedWindow };
    setFeedWindowByThread((current) => ({
      ...current,
      [selectedThreadKey]:
        (current[selectedThreadKey] ?? DEFAULT_THREAD_FEED_WINDOW_MESSAGES) +
        DEFAULT_THREAD_FEED_WINDOW_MESSAGES,
    }));
  }, [selectedThreadKey, feedWindow]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    try {
      await enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        modelSelection: draft.modelSelection ?? thread.modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: draft.interactionMode ?? thread.interactionMode,
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey);
      return messageId;
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
      return null;
    }
  }, [selectedThreadDetail, selectedThreadShell]);

  const { sendQueuedMessage } = useThreadOutboxDelivery();

  const onSteerQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage) => {
      // Steer bypasses the drain's thread-busy gate on purpose: the server
      // treats a turn start on a running thread as a steer into that turn.
      if (
        !selectedThreadShell ||
        scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id) !==
          scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId) ||
        queuedMessage.creation !== undefined
      ) {
        return;
      }
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return;
      }
      if (!claimQueuedMessageDispatch(queuedMessage.messageId)) {
        // Another delivery holds the dispatch slot; steering now could send
        // the same message twice.
        return;
      }
      try {
        const sent = await sendQueuedMessage(queuedMessage, selectedThreadShell);
        if (!sent) {
          setPendingConnectionError("Could not send the queued message. It stays queued.");
        }
      } finally {
        finishDispatchingQueuedMessage(queuedMessage.messageId);
      }
    },
    [selectedThreadShell, sendQueuedMessage],
  );

  const onEditQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage) => {
      if (!selectedThreadShell) {
        return;
      }
      if (appAtomRegistry.get(dispatchingQueuedMessageIdAtom) === queuedMessage.messageId) {
        // Mid-delivery; pulling it into the draft now would fork the payload.
        return;
      }
      // Hold the drain off this message while it moves into the draft, so it
      // cannot be delivered between the decision to edit and the removal.
      holdEditingQueuedMessage(queuedMessage.messageId);
      try {
        await removeThreadOutboxMessage(queuedMessage);
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to load the queued message for editing.",
        );
        return;
      } finally {
        releaseEditingQueuedMessage(queuedMessage.messageId);
      }
      appendToThreadComposerDraft({
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        text: queuedMessage.text,
        attachments: queuedMessage.attachments,
      });
      // Carry the queued settings into the draft so a later send keeps what
      // the user originally picked for this message.
      const threadKey = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
      updateComposerDraftSettings(threadKey, {
        ...(queuedMessage.modelSelection !== undefined
          ? { modelSelection: queuedMessage.modelSelection }
          : {}),
        ...(queuedMessage.runtimeMode !== undefined
          ? { runtimeMode: queuedMessage.runtimeMode }
          : {}),
        ...(queuedMessage.interactionMode !== undefined
          ? { interactionMode: queuedMessage.interactionMode }
          : {}),
      });
    },
    [selectedThreadShell],
  );

  const onDeleteQueuedMessage = useCallback(async (queuedMessage: QueuedThreadMessage) => {
    // Hold the drain off while removing so it cannot deliver mid-delete.
    holdEditingQueuedMessage(queuedMessage.messageId);
    try {
      await removeThreadOutboxMessage(queuedMessage);
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to delete the queued message.",
      );
    } finally {
      releaseEditingQueuedMessage(queuedMessage.messageId);
    }
  }, []);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    onLoadEarlier,
    selectedThreadQueuedMessages,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onSteerQueuedMessage,
    onEditQueuedMessage,
    onDeleteQueuedMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
