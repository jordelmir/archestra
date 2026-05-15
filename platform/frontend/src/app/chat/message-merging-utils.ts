import type { UIMessage } from "@ai-sdk/react";
import type { PartialUIMessage } from "@shared";

/**
 * A permissive type for message merging that accounts for different AI SDK versions
 * and Archestra-specific rich content parts.
 */
export type MergableUIMessage = PartialUIMessage & {
  toolInvocations?: Array<{ toolName?: string }>;
  content?: string;
  experimental_attachments?: unknown[];
};

type MessagePart = {
  type?: string;
  text?: string;
  toolName?: string;
  toolInvocation?: {
    toolName?: string;
  };
};

function getMessageParts(message: MergableUIMessage): MessagePart[] {
  return Array.isArray(message.parts) ? (message.parts as MessagePart[]) : [];
}

/**
 * Determines if two message objects refer to the same logical interaction.
 * Uses a multi-factor approach: ID, Role, Text Content, and Tool Call signatures.
 */
export function messagesHaveSameRenderableContent(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  const lm = params.liveMessage as MergableUIMessage;
  const pm = params.persistedMessage as MergableUIMessage;

  // 1. Strict ID Match
  if (lm.id && pm.id && lm.id === pm.id) {
    return true;
  }

  // 2. Identity Check
  if (lm.role !== pm.role) {
    return false;
  }

  // 3. Text Content Match
  const liveText = getMessageText(lm);
  const persistedText = getMessageText(pm);
  if (liveText !== persistedText) {
    return false;
  }

  // 4. Attachment Check
  const getAttachmentCount = (msg: MergableUIMessage) => {
    let count = msg.experimental_attachments?.length || 0;
    count += getMessageParts(msg).filter(
      (part) => part.type === "image" || part.type === "file",
    ).length;
    return count;
  };
  if (getAttachmentCount(lm) !== getAttachmentCount(pm)) {
    return false;
  }

  // 5. Tool Call Signature Verification
  const getToolNames = (msg: MergableUIMessage) => {
    const names: string[] = [];
    for (const part of getMessageParts(msg)) {
      if (part.type === "tool-call" || part.type === "tool-invocation") {
        const toolName = part.toolName || part.toolInvocation?.toolName;
        if (toolName) {
          names.push(toolName);
        }
      }
    }
    if (msg.toolInvocations) {
      for (const invocation of msg.toolInvocations) {
        if (invocation.toolName) {
          names.push(invocation.toolName);
        }
      }
    }
    return names;
  };

  const liveTools = getToolNames(lm);
  const persistedTools = getToolNames(pm);

  if (liveTools.length !== persistedTools.length) {
    return false;
  }

  return liveTools.every((name, i) => name === persistedTools[i]);
}

export function mergePersistedMessageMetadata(params: {
  liveMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): UIMessage[] {
  const remainingPersistedMessages = params.persistedMessages.map(
    (message, originalIndex) => ({ message, originalIndex }),
  );
  let lastMatchedPersistedIndex = -1;

  const mergedMessages = params.liveMessages.map((liveMessage) => {
    if (hasCreatedAtMetadata(liveMessage)) {
      return liveMessage;
    }

    const persistedIndex = remainingPersistedMessages.findIndex(
      ({ message: persistedMessage }) =>
        messagesHaveSameRenderableContent({
          liveMessage,
          persistedMessage,
        }),
    );

    if (persistedIndex === -1) {
      return liveMessage;
    }

    const [persistedEntry] = remainingPersistedMessages.splice(
      persistedIndex,
      1,
    );
    lastMatchedPersistedIndex = Math.max(
      lastMatchedPersistedIndex,
      persistedEntry.originalIndex,
    );

    return {
      ...liveMessage,
      metadata: {
        ...getObjectMetadata(persistedEntry.message),
        ...getObjectMetadata(liveMessage),
      },
    };
  });

  const shouldRecoverPersistedTail =
    mergedMessages.length === 0 ||
    (lastMatchedPersistedIndex >= 0 && mergedMessages.at(-1)?.role === "user");

  if (!shouldRecoverPersistedTail) {
    return mergedMessages;
  }

  return [
    ...mergedMessages,
    ...params.persistedMessages.slice(lastMatchedPersistedIndex + 1),
  ];
}

export function getMessageText(message: unknown) {
  const msg = message as MergableUIMessage;
  const parts = getMessageParts(msg);
  if (parts.length > 0) {
    return parts
      .map((part) => (part.type === "text" ? part.text || "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof msg.content === "string" ? msg.content : "";
}

export function hasCreatedAtMetadata(message: unknown) {
  const metadata = getObjectMetadata(message);
  return typeof metadata.createdAt === "string";
}

export function getObjectMetadata(message: unknown): Record<string, unknown> {
  const msg = message as MergableUIMessage;
  return typeof msg.metadata === "object" && msg.metadata !== null
    ? { ...(msg.metadata as Record<string, unknown>) }
    : {};
}
