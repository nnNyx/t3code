import { BotIcon, CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import type { SubagentRailItem, WorkLogEntry } from "../../session-logic";
import { WorkingTimer } from "../WorkingTimer";
import { buildToolCallExpandedBody } from "./MessagesTimeline";

/**
 * Toggleable right-panel body listing the active turn's subagents (collab agent
 * tool calls). Unlike the floating {@link SubagentRail}, this surface keeps
 * completed and failed agents around so they stay reviewable after the turn
 * settles. Each row expands inline to its full task/description and tool detail.
 */
export const SubagentsPanel = memo(function SubagentsPanel({
  items,
  entriesById,
  workspaceRoot,
}: {
  items: ReadonlyArray<SubagentRailItem>;
  entriesById: ReadonlyMap<string, WorkLogEntry>;
  workspaceRoot: string | undefined;
}) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="text-center text-sm text-muted-foreground">No subagents yet.</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.id}>
            <SubagentRow
              item={item}
              entry={entriesById.get(item.id)}
              workspaceRoot={workspaceRoot}
            />
          </li>
        ))}
      </ul>
    </div>
  );
});

function SubagentRow({
  item,
  entry,
  workspaceRoot,
}: {
  item: SubagentRailItem;
  entry: WorkLogEntry | undefined;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  // buildToolCallExpandedBody surfaces the subagent's dispatch input
  // (type/model/prompt) and deliberately omits the "<type>: <description>" label
  // that the row already shows, so a non-null result is genuinely richer. When it
  // is null there is nothing beyond the label to show, so avoid repeating
  // item.detail verbatim in the expansion.
  const expandedBody = entry ? buildToolCallExpandedBody(entry, workspaceRoot) : null;
  const detailText =
    expandedBody ??
    (item.status === "running"
      ? "This subagent is just getting started — no task description reported yet."
      : "No further detail reported for this subagent.");

  return (
    <div
      className={cn(
        "flex cursor-pointer flex-col rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        item.status === "completed" && "opacity-70",
      )}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={item.name}
      onClick={() => setExpanded((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setExpanded((value) => !value);
        }
      }}
    >
      <div className="flex select-none items-start gap-1.5">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
          <BotIcon className="block size-3.5 shrink-0" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-5 text-foreground/85">
              {item.name}
            </span>
            {item.status === "running" ? (
              <WorkingTimer
                createdAt={item.createdAt}
                className="shrink-0 text-[11px] text-muted-foreground/55 tabular-nums"
              />
            ) : null}
            <SubagentStatusGlyph status={item.status} />
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-muted-foreground/55 transition-transform duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          </div>
          <span
            className={cn(
              "block truncate text-[11px] leading-4",
              item.detail ? "text-muted-foreground/70" : "text-muted-foreground/45 italic",
            )}
          >
            {subagentTaskLabel(item)}
          </span>
        </div>
      </div>
      {expanded ? (
        <div
          className="mt-1 ms-6 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className="max-h-72 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {detailText}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

const stopRowToggle = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** One-line task summary for a row — mirrors the floating rail's phrasing. */
function subagentTaskLabel(item: SubagentRailItem): string {
  if (item.detail) {
    return item.detail;
  }
  return item.status === "running" ? "Subagent starting…" : "No task recorded";
}

/** Status indicator — running reuses the sky "Working" dot from the session status pill. */
function SubagentStatusGlyph({ status }: { status: SubagentRailItem["status"] }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {status === "running" ? (
        <span
          className="block size-2 animate-pulse rounded-full bg-sky-500 dark:bg-sky-300/80"
          aria-label="Working"
        />
      ) : status === "failed" ? (
        <XIcon className="block size-3 text-destructive" aria-label="Failed" />
      ) : (
        <CheckIcon className="block size-3 text-muted-foreground/70" aria-label="Completed" />
      )}
    </span>
  );
}
