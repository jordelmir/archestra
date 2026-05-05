import { describe, expect, it, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { ZendeskConnector } from "./zendesk-connector";

// ===== Constants =====

const ZENDESK_URL = "https://acme.zendesk.com";
const credentials = { email: "agent@example.com", apiToken: "zd_api_token_123" };
const baseConfig = { type: "zendesk" as const, zendeskUrl: ZENDESK_URL };

type SpyTarget = {
  fetchWithRetry: (...args: unknown[]) => unknown;
  rateLimit: () => unknown;
};

// ===== Helpers =====

function makeTicket(
  id: number,
  subject: string,
  opts?: {
    status?: string;
    tags?: string[];
    description?: string;
    updatedAt?: string;
    requesterId?: number;
    assigneeId?: number;
  },
) {
  return {
    id,
    subject,
    description: opts?.description ?? `Description of ${subject}`,
    status: opts?.status ?? "open",
    requester_id: opts?.requesterId ?? 1001,
    assignee_id: opts?.assigneeId ?? 2001,
    tags: opts?.tags ?? [],
    created_at: "2026-05-01T10:00:00Z",
    updated_at: opts?.updatedAt ?? "2026-05-01T12:00:00Z",
  };
}

function makeTicketExportResponse(
  tickets: ReturnType<typeof makeTicket>[],
  opts?: { afterCursor?: string; endOfStream?: boolean },
) {
  return {
    ok: true,
    json: async () => ({
      tickets,
      after_cursor: opts?.afterCursor ?? "cursor_default",
      end_of_stream: opts?.endOfStream ?? true,
    }),
    text: async () => "",
  } as unknown as Response;
}

function makeCommentsResponse(
  comments: { body: string; author_id: number; created_at: string }[],
) {
  return {
    ok: true,
    json: async () => ({ comments }),
    text: async () => "",
  } as unknown as Response;
}

function makeErrorResponse(status: number, body = "Error") {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

function makeAuthResponse(ok = true) {
  return {
    ok,
    status: ok ? 200 : 401,
    statusText: ok ? "OK" : "Unauthorized",
    json: async () => (ok ? { user: { id: 1, name: "Agent" } } : {}),
    text: async () => (ok ? "" : "Unauthorized"),
  } as unknown as Response;
}

async function collectBatches(
  gen: AsyncGenerator<ConnectorSyncBatch>,
): Promise<ConnectorSyncBatch[]> {
  const batches: ConnectorSyncBatch[] = [];
  for await (const b of gen) batches.push(b);
  return batches;
}

// ===== Tests =====

describe("ZendeskConnector", () => {
  it("has the correct type", () => {
    expect(new ZendeskConnector().type).toBe("zendesk");
  });

  // ----- validateConfig -----

  describe("validateConfig", () => {
    it("returns valid for correct config", async () => {
      const connector = new ZendeskConnector();
      const result = await connector.validateConfig({ zendeskUrl: ZENDESK_URL });
      expect(result).toEqual({ valid: true });
    });

    it("returns invalid when zendeskUrl is missing", async () => {
      const connector = new ZendeskConnector();
      const result = await connector.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain("zendeskUrl");
    });

    it("returns invalid when zendeskUrl is not a string", async () => {
      const connector = new ZendeskConnector();
      const result = await connector.validateConfig({ zendeskUrl: 123 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("zendeskUrl");
    });
  });

  // ----- testConnection -----

  describe("testConnection", () => {
    it("returns success when /api/v2/users/me responds OK", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeAuthResponse(true));

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });

      expect(result).toEqual({ success: true });
    });

    it("verifies Basic auth header construction", async () => {
      const connector = new ZendeskConnector();
      const fetchSpy = vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeAuthResponse(true));

      await connector.testConnection({ config: baseConfig, credentials });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/api/v2/users/me.json");

      const opts = fetchSpy.mock.calls[0][1] as RequestInit;
      const authHeader = (opts.headers as Record<string, string>).Authorization;
      const decoded = Buffer.from(
        authHeader.replace("Basic ", ""),
        "base64",
      ).toString();
      expect(decoded).toBe("agent@example.com/token:zd_api_token_123");
    });

    it("returns failure when email is missing", async () => {
      const connector = new ZendeskConnector();
      const result = await connector.testConnection({
        config: baseConfig,
        credentials: { apiToken: "token" },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Email");
    });

    it("returns failure for HTTP error", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValue(makeAuthResponse(false));

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    it("returns failure on network error", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await connector.testConnection({
        config: baseConfig,
        credentials,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    });
  });

  // ----- sync -----

  describe("sync", () => {
    it("syncs a single ticket with comments", async () => {
      const connector = new ZendeskConnector();
      const ticket = makeTicket(101, "Login broken", {
        requesterId: 999,
        assigneeId: 888,
        tags: ["bug"],
      });

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([ticket], {
            afterCursor: "cursor_abc",
            endOfStream: true,
          }),
        )
        .mockResolvedValueOnce(
          makeCommentsResponse([
            {
              body: "I cannot log in",
              author_id: 999,
              created_at: "2026-05-01T10:00:00Z",
            },
            {
              body: "Have you tried clearing cache?",
              author_id: 888,
              created_at: "2026-05-01T11:00:00Z",
            },
          ]),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(1);
      const doc = batches[0].documents[0];
      expect(doc.id).toBe("ticket:101");
      expect(doc.title).toBe("Login broken");
      expect(doc.content).toContain("Have you tried clearing cache?");
      expect(doc.sourceUrl).toBe(
        "https://acme.zendesk.com/agent/tickets/101",
      );
      expect(doc.metadata).toMatchObject({
        status: "open",
        requester_id: 999,
        assignee_id: 888,
        tags: ["bug"],
      });

      // Checkpoint should contain the cursor
      expect(batches[0].checkpoint.type).toBe("zendesk");
      expect((batches[0].checkpoint as any).lastCursor).toBe("cursor_abc");
      expect(batches[0].hasMore).toBe(false);
    });

    it("filters by ticketStatuses", async () => {
      const connector = new ZendeskConnector();
      const tickets = [
        makeTicket(201, "Open ticket", { status: "open" }),
        makeTicket(202, "Closed ticket", { status: "closed" }),
      ];

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse(tickets, { endOfStream: true }),
        )
        // Only ticket 201 should fetch comments (202 is filtered)
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({
          config: { ...baseConfig, ticketStatuses: ["open", "pending"] },
          credentials,
          checkpoint: null,
        }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("ticket:201");
      // The closed ticket should be skipped
      expect(batches[0].skipped).toBeDefined();
      expect(batches[0].skipped!.length).toBeGreaterThanOrEqual(1);
      expect(batches[0].skipped![0].itemId).toBe(202);
    });

    it("filters by tagsToSkip", async () => {
      const connector = new ZendeskConnector();
      const tickets = [
        makeTicket(301, "Normal ticket", { tags: ["support"] }),
        makeTicket(302, "Spam ticket", { tags: ["spam", "support"] }),
      ];

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse(tickets, { endOfStream: true }),
        )
        // Only ticket 301 should fetch comments
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({
          config: { ...baseConfig, tagsToSkip: ["spam", "internal"] },
          credentials,
          checkpoint: null,
        }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("ticket:301");
      expect(batches[0].skipped!.length).toBeGreaterThanOrEqual(1);
    });

    it("uses cursor from checkpoint for incremental sync", async () => {
      const connector = new ZendeskConnector();
      const fetchSpy = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([], { endOfStream: true }),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      await collectBatches(
        connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: {
            type: "zendesk",
            lastSyncedAt: "2026-05-01T00:00:00Z",
            lastCursor: "cursor_prev",
          },
        }),
      );

      // Verify the cursor was passed in the request URL
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("cursor=cursor_prev");
    });

    it("falls back to lastSyncedAt when no cursor in checkpoint", async () => {
      const connector = new ZendeskConnector();
      const fetchSpy = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([], { endOfStream: true }),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      await collectBatches(
        connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: {
            type: "zendesk",
            lastSyncedAt: "2026-05-01T00:00:00Z",
          },
        }),
      );

      // Should convert lastSyncedAt to UNIX timestamp for cursor
      const url = fetchSpy.mock.calls[0][0] as string;
      const cursorParam = new URL(url).searchParams.get("cursor");
      const expectedTimestamp = Math.floor(
        new Date("2026-05-01T00:00:00Z").getTime() / 1000,
      );
      expect(cursorParam).toBe(expectedTimestamp.toString());
    });

    it("starts from beginning (cursor=0) on first sync", async () => {
      const connector = new ZendeskConnector();
      const fetchSpy = vi
        .spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([], { endOfStream: true }),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      await collectBatches(
        connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: null,
        }),
      );

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("cursor=0");
    });

    it("paginates across multiple pages", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        // Page 1 — not end of stream
        .mockResolvedValueOnce(
          makeTicketExportResponse([makeTicket(401, "Ticket A")], {
            afterCursor: "cursor_page2",
            endOfStream: false,
          }),
        )
        // Comments for ticket 401
        .mockResolvedValueOnce(makeCommentsResponse([]))
        // Page 2 — end of stream
        .mockResolvedValueOnce(
          makeTicketExportResponse(
            [
              makeTicket(402, "Ticket B", {
                updatedAt: "2026-05-01T14:00:00Z",
              }),
            ],
            {
              afterCursor: "cursor_done",
              endOfStream: true,
            },
          ),
        )
        // Comments for ticket 402
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      const allDocs = batches.flatMap((b) => b.documents);
      expect(allDocs).toHaveLength(2);
      expect(allDocs[0].id).toBe("ticket:401");
      expect(allDocs[1].id).toBe("ticket:402");

      // Last batch should indicate no more data
      expect(batches[batches.length - 1].hasMore).toBe(false);
    });

    it("handles empty ticket list gracefully", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValueOnce(
        makeTicketExportResponse([], { endOfStream: true }),
      );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].hasMore).toBe(false);
    });

    it("survives comment fetch failure via safeItemFetch", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse(
            [makeTicket(501, "Good ticket", { description: "Ticket body" })],
            { endOfStream: true },
          ),
        )
        // Comments fetch fails
        .mockResolvedValueOnce(makeErrorResponse(404, "Not Found"));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      // Document should still be produced (with description only, no comments)
      expect(batches).toHaveLength(1);
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].content).toBe("Ticket body");
      // Failure should be recorded
      expect(batches[0].failures).toBeDefined();
      expect(batches[0].failures!.length).toBeGreaterThanOrEqual(1);
    });

    it("throws on ticket export HTTP error", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValueOnce(makeErrorResponse(403, "Forbidden"));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      await expect(
        collectBatches(
          connector.sync({
            config: baseConfig,
            credentials,
            checkpoint: null,
          }),
        ),
      ).rejects.toThrow("Failed to fetch tickets");
    });

    it("throws when email is missing from credentials", async () => {
      const connector = new ZendeskConnector();

      await expect(
        collectBatches(
          connector.sync({
            config: baseConfig,
            credentials: { apiToken: "token" },
            checkpoint: null,
          }),
        ),
      ).rejects.toThrow("Email is required");
    });

    it("uses fallback title when subject is null", async () => {
      const connector = new ZendeskConnector();
      const ticket = makeTicket(601, "Placeholder");
      // biome-ignore lint/suspicious/noExplicitAny: override for null subject test
      (ticket as any).subject = null;

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([ticket], { endOfStream: true }),
        )
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      expect(batches[0].documents[0].title).toBe("Ticket #601");
    });

    it("builds correct sourceUrl from zendeskUrl", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([makeTicket(701, "URL test")], {
            endOfStream: true,
          }),
        )
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://acme.zendesk.com/agent/tickets/701",
      );
    });

    it("includes ticket metadata in document", async () => {
      const connector = new ZendeskConnector();
      const ticket = makeTicket(801, "Metadata test", {
        status: "pending",
        requesterId: 5555,
        assigneeId: 6666,
        tags: ["urgent", "billing"],
      });

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([ticket], { endOfStream: true }),
        )
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      const metadata = batches[0].documents[0].metadata;
      expect(metadata.status).toBe("pending");
      expect(metadata.requester_id).toBe(5555);
      expect(metadata.assignee_id).toBe(6666);
      expect(metadata.tags).toEqual(["urgent", "billing"]);
    });

    it("deduplicates description from comments", async () => {
      const connector = new ZendeskConnector();
      const ticket = makeTicket(901, "Dedup test", {
        description: "Initial report of the issue",
      });

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse([ticket], { endOfStream: true }),
        )
        .mockResolvedValueOnce(
          makeCommentsResponse([
            {
              // This is the same as description — should be deduplicated
              body: "Initial report of the issue",
              author_id: 1001,
              created_at: "2026-05-01T10:00:00Z",
            },
            {
              body: "Follow-up comment",
              author_id: 2001,
              created_at: "2026-05-01T11:00:00Z",
            },
          ]),
        );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({ config: baseConfig, credentials, checkpoint: null }),
      );

      const content = batches[0].documents[0].content;
      // The description should appear exactly once (as the base content)
      // The duplicate comment should be filtered; only the follow-up remains
      const descriptionCount = (
        content.match(/Initial report of the issue/g) || []
      ).length;
      expect(descriptionCount).toBe(1);
      expect(content).toContain("Follow-up comment");
    });

    it("checkpoint preserves previous lastSyncedAt when batch has no tickets", async () => {
      const connector = new ZendeskConnector();
      vi.spyOn(
        connector as unknown as SpyTarget,
        "fetchWithRetry",
      ).mockResolvedValueOnce(
        makeTicketExportResponse([], {
          afterCursor: "cursor_empty",
          endOfStream: true,
        }),
      );
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({
          config: baseConfig,
          credentials,
          checkpoint: {
            type: "zendesk",
            lastSyncedAt: "2026-05-01T00:00:00Z",
            lastCursor: "cursor_prev",
          },
        }),
      );

      const checkpoint = batches[0].checkpoint as {
        lastSyncedAt?: string;
        lastCursor?: string;
      };
      expect(checkpoint.lastSyncedAt).toBe("2026-05-01T00:00:00Z");
      expect(checkpoint.lastCursor).toBe("cursor_empty");
    });

    it("no status filter means all statuses are synced", async () => {
      const connector = new ZendeskConnector();
      const tickets = [
        makeTicket(1001, "Open", { status: "open" }),
        makeTicket(1002, "Closed", { status: "closed" }),
        makeTicket(1003, "Pending", { status: "pending" }),
      ];

      vi.spyOn(connector as unknown as SpyTarget, "fetchWithRetry")
        .mockResolvedValueOnce(
          makeTicketExportResponse(tickets, { endOfStream: true }),
        )
        // Comments for each ticket
        .mockResolvedValueOnce(makeCommentsResponse([]))
        .mockResolvedValueOnce(makeCommentsResponse([]))
        .mockResolvedValueOnce(makeCommentsResponse([]));
      vi.spyOn(
        connector as unknown as SpyTarget,
        "rateLimit",
      ).mockResolvedValue(undefined);

      const batches = await collectBatches(
        connector.sync({
          config: baseConfig, // No ticketStatuses filter
          credentials,
          checkpoint: null,
        }),
      );

      // All 3 tickets should be synced
      expect(batches[0].documents).toHaveLength(3);
    });
  });
});
