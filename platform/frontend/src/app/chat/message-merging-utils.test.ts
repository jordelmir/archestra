import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, test } from "vitest";
import { mergePersistedMessageMetadata } from "./message-merging-utils";

function textMessage(params: {
  id: string;
  role: UIMessage["role"];
  text: string;
  metadata?: Record<string, unknown>;
}): UIMessage {
  return {
    id: params.id,
    role: params.role,
    parts: [{ type: "text", text: params.text }],
    metadata: params.metadata,
  } as UIMessage;
}

describe("mergePersistedMessageMetadata", () => {
  test("merges persisted metadata into matching live messages", () => {
    const [merged] = mergePersistedMessageMetadata({
      liveMessages: [
        textMessage({
          id: "live-user",
          role: "user",
          text: "Hello",
          metadata: { local: true },
        }),
      ],
      persistedMessages: [
        textMessage({
          id: "persisted-user",
          role: "user",
          text: "Hello",
          metadata: { createdAt: "2026-05-15T00:00:00.000Z" },
        }),
      ],
    });

    expect(merged.metadata).toEqual({
      createdAt: "2026-05-15T00:00:00.000Z",
      local: true,
    });
  });

  test("recovers trailing persisted assistant messages after reload when live chat is waiting on the assistant turn", () => {
    const liveUser = textMessage({
      id: "live-user",
      role: "user",
      text: "Summarize the repo",
    });
    const persistedAssistant = textMessage({
      id: "persisted-assistant",
      role: "assistant",
      text: "Summary complete",
      metadata: { createdAt: "2026-05-15T00:00:01.000Z" },
    });

    const merged = mergePersistedMessageMetadata({
      liveMessages: [liveUser],
      persistedMessages: [
        textMessage({
          id: "persisted-user",
          role: "user",
          text: "Summarize the repo",
          metadata: { createdAt: "2026-05-15T00:00:00.000Z" },
        }),
        persistedAssistant,
      ],
    });

    expect(merged.map((message) => message.id)).toEqual([
      "live-user",
      "persisted-assistant",
    ]);
  });

  test("does not resurrect persisted messages when the live message does not match persisted history", () => {
    const merged = mergePersistedMessageMetadata({
      liveMessages: [
        textMessage({
          id: "live-user",
          role: "user",
          text: "New edited request",
        }),
      ],
      persistedMessages: [
        textMessage({
          id: "persisted-user",
          role: "user",
          text: "Old request",
        }),
        textMessage({
          id: "persisted-assistant",
          role: "assistant",
          text: "Old response",
        }),
      ],
    });

    expect(merged.map((message) => message.id)).toEqual(["live-user"]);
  });

  test("does not append persisted tail while a live assistant message is already present", () => {
    const merged = mergePersistedMessageMetadata({
      liveMessages: [
        textMessage({
          id: "live-user",
          role: "user",
          text: "Summarize the repo",
        }),
        textMessage({
          id: "live-assistant",
          role: "assistant",
          text: "Summary in progress",
        }),
      ],
      persistedMessages: [
        textMessage({
          id: "persisted-user",
          role: "user",
          text: "Summarize the repo",
        }),
        textMessage({
          id: "persisted-assistant",
          role: "assistant",
          text: "Summary complete",
        }),
      ],
    });

    expect(merged.map((message) => message.id)).toEqual([
      "live-user",
      "live-assistant",
    ]);
  });
});
