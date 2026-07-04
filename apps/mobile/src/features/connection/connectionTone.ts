import type { StatusTone } from "../../components/StatusPill";
import type { RemoteClientConnectionState } from "../../lib/connection";

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: "Connected",
        pillClassName: "bg-success-surface",
        textClassName: "text-success-foreground",
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        pillClassName: "bg-warning-surface",
        textClassName: "text-warning-foreground",
      };
    case "connecting":
      return {
        label: "Connecting",
        pillClassName: "bg-accent",
        textClassName: "text-accent-foreground",
      };
    case "error":
      return {
        label: "Connection failed",
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "offline":
      return {
        label: "Offline",
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
      };
    case "available":
      return {
        label: "Available",
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-muted",
      };
  }
}
