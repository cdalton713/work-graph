export const pageEvents = {
  overview_viewed: { event: "page_view", fields: { page: "overview" } },
  project_viewed: { event: "page_view", fields: { page: "project" } },
  settings_viewed: { event: "page_view", fields: { page: "settings" } },
  onboarding_viewed: { event: "page_view", fields: { page: "onboarding" } },
  share_dialog_opened: { event: "share_dialog_opened", fields: {} },
  node_opened: { event: "node_opened", fields: {} },
  comment_written: { event: "page_write", fields: { kind: "comment" } },
  status_written: { event: "page_write", fields: { kind: "status" } },
  answer_written: { event: "page_write", fields: { kind: "answer" } },
  command_written: { event: "page_write", fields: { kind: "command" } },
} as const;

export type PageEvent = keyof typeof pageEvents;

let enabled = false;

export function configureTelemetry(available: boolean) {
  enabled = available;
}

export const usageEnabled = () => enabled;

export function pageEvent(event: PageEvent, workspace: string) {
  if (!usageEnabled() || !workspace) return;
  void fetch("/api/events", {
    method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, workspace }),
  }).catch(() => {});
}
