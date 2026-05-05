import type {
  ConnectorCredentials,
  ConnectorSyncBatch,
  ZendeskCheckpoint,
  ZendeskConfig,
} from "@/types";
import { BaseConnector, buildCheckpoint } from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;

export class ZendeskConnector extends BaseConnector {
  type = "zendesk" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!config.zendeskUrl || typeof config.zendeskUrl !== "string") {
        return { valid: false, error: "zendeskUrl is required" };
      }
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const config = params.config as ZendeskConfig;
      const url = this.joinUrl(config.zendeskUrl, "/api/v2/users/me.json");

      if (!params.credentials.email) {
        return { success: false, error: "Email is required for Zendesk auth" };
      }

      const response = await this.fetchWithRetry(url, {
        headers: {
          Authorization: this.buildBasicAuthHeader(
            `${params.credentials.email}/token`,
            params.credentials.apiToken,
          ),
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `Failed to connect to Zendesk: ${response.status} ${text}`,
        };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const config = params.config as ZendeskConfig;
    const checkpoint = (params.checkpoint || {}) as ZendeskCheckpoint;
    const batchSize = config.batchSize || DEFAULT_BATCH_SIZE;

    if (!params.credentials.email) {
      throw new Error("Email is required for Zendesk auth");
    }

    const authHeader = this.buildBasicAuthHeader(
      `${params.credentials.email}/token`,
      params.credentials.apiToken,
    );

    let currentCursor = checkpoint.lastCursor || "";
    let endOfStream = false;

    // We can use start_time if there is no cursor. We can convert lastSyncedAt to UNIX timestamp.
    if (!currentCursor && checkpoint.lastSyncedAt) {
      const startTime = Math.floor(
        new Date(checkpoint.lastSyncedAt).getTime() / 1000,
      );
      currentCursor = startTime.toString();
    } else if (!currentCursor) {
      currentCursor = "0"; // Sync from beginning
    }

    while (!endOfStream) {
      await this.rateLimit();

      const url = new URL(
        this.joinUrl(
          config.zendeskUrl,
          "/api/v2/incremental/tickets/cursor.json",
        ),
      );
      url.searchParams.append("cursor", currentCursor);

      const response = await this.fetchWithRetry(url.toString(), {
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to fetch tickets: ${response.status} ${response.statusText} - ${text}`,
        );
      }

      const data = await response.json();
      const tickets = data.tickets || [];
      endOfStream = data.end_of_stream;

      const documents = [];

      for (const ticket of tickets) {
        // Apply filters
        if (
          config.ticketStatuses &&
          config.ticketStatuses.length > 0 &&
          !config.ticketStatuses.includes(ticket.status)
        ) {
          this.trackSkipped({
            itemId: ticket.id,
            name: ticket.subject,
            reason: `Status '${ticket.status}' not in allowed statuses`,
          });
          continue;
        }

        if (
          config.tagsToSkip &&
          config.tagsToSkip.length > 0 &&
          ticket.tags.some((tag: string) => config.tagsToSkip!.includes(tag))
        ) {
          this.trackSkipped({
            itemId: ticket.id,
            name: ticket.subject,
            reason: `Has skipped tag`,
          });
          continue;
        }

        // Fetch comments
        const comments = await this.safeItemFetch({
          fetch: async () => {
            const commentsUrl = this.joinUrl(
              config.zendeskUrl,
              `/api/v2/tickets/${ticket.id}/comments.json`,
            );
            const commentsResponse = await this.fetchWithRetry(commentsUrl, {
              headers: { Authorization: authHeader, Accept: "application/json" },
            });
            if (!commentsResponse.ok) {
              throw new Error(`Failed to fetch comments: ${commentsResponse.status}`);
            }
            const commentsData = await commentsResponse.json();
            return commentsData.comments || [];
          },
          fallback: [],
          itemId: ticket.id,
          resource: "comments",
        });

        // Combine description + comments
        let content = ticket.description || "";
        for (const comment of comments) {
          if (comment.body && comment.body !== ticket.description) {
            content += `\n\n---\n\nComment by Author ID ${comment.author_id} at ${comment.created_at}:\n${comment.body}`;
          }
        }

        const updatedAt = ticket.updated_at
          ? new Date(ticket.updated_at)
          : undefined;

        documents.push({
          id: `ticket:${ticket.id}`,
          title: ticket.subject || `Ticket #${ticket.id}`,
          content: content,
          sourceUrl: this.joinUrl(
            config.zendeskUrl,
            `/agent/tickets/${ticket.id}`,
          ),
          metadata: {
            status: ticket.status,
            requester_id: ticket.requester_id,
            assignee_id: ticket.assignee_id,
            tags: ticket.tags,
            created_at: ticket.created_at,
          },
          updatedAt,
        });

        // Yield in batches
        if (documents.length >= batchSize) {
          const currentUpdatedAt =
            documents[documents.length - 1]?.updatedAt?.toISOString();

          yield {
            documents: documents.splice(0, batchSize),
            failures: this.flushFailures(),
            skipped: this.flushSkipped(),
            checkpoint: buildCheckpoint({
              type: "zendesk",
              itemUpdatedAt: currentUpdatedAt,
              previousLastSyncedAt: checkpoint.lastSyncedAt,
              extra: { lastCursor: data.after_cursor },
            }),
            hasMore: true,
          };
        }
      }

      currentCursor = data.after_cursor;

      if (documents.length > 0 || endOfStream) {
        yield {
          documents,
          failures: this.flushFailures(),
          skipped: this.flushSkipped(),
          checkpoint: buildCheckpoint({
            type: "zendesk",
            itemUpdatedAt:
              documents.length > 0
                ? documents[documents.length - 1]?.updatedAt?.toISOString()
                : undefined,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: { lastCursor: currentCursor },
          }),
          hasMore: !endOfStream,
        };
      }
    }
  }
}
