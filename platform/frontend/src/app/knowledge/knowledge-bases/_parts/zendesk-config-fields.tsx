"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface ZendeskConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
  hideZendeskUrl?: boolean;
}

export function ZendeskConfigFields({
  form,
  prefix = "config",
  hideZendeskUrl = false,
}: ZendeskConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <p className="text-[0.8rem] text-muted-foreground">
        Syncs tickets and their comments from Zendesk.
      </p>

      {!hideZendeskUrl && (
        <FormField
          control={form.control}
          name={`${prefix}.zendeskUrl`}
          rules={{ required: "Zendesk URL is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Zendesk URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://yourcompany.zendesk.com"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>
                The base URL of your Zendesk instance.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name={`${prefix}.ticketStatuses`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Ticket Statuses (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="open, pending, solved, closed"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of ticket statuses to sync. Leave blank to
              sync tickets with any status.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.tagsToSkip`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Tags to Skip (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="internal, spam"
                {...field}
                value={field.value ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of tags to exclude.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.includeHelpCenterArticles`}
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <FormLabel className="text-base">
                Include Help Center Articles
              </FormLabel>
              <FormDescription>
                Sync knowledge base articles from Zendesk Guide.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value ?? false}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}
