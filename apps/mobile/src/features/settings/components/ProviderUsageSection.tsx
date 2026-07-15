import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useServerConfigs } from "../../../state/entities";
import { SettingsSection } from "./SettingsSection";

function formatUsagePercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped > 0 && clamped < 10) {
    return `${clamped.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(clamped)}%`;
}

function formatResetLabel(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const parsed = new Date(resetsAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return `resets ${parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * A single plan/usage window rendered as a slim progress bar with its label,
 * percent, and reset time. Bar color escalates with consumption using the same
 * semantic tokens as the rest of the app (primary → warning → danger).
 */
function ProviderUsageWindowRow(props: { readonly window: ServerProviderUsageWindow }) {
  const primary = useThemeColor("--color-primary");
  const warning = useThemeColor("--color-warning");
  const danger = useThemeColor("--color-danger-foreground");
  const track = useThemeColor("--color-border");

  const percent = Math.max(0, Math.min(100, props.window.usedPercent));
  const fill = percent >= 90 ? danger : percent >= 75 ? warning : primary;
  const resetLabel = formatResetLabel(props.window.resetsAt);
  const percentLabel = formatUsagePercent(props.window.usedPercent);

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.window.label}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {resetLabel ? `${percentLabel} · ${resetLabel}` : percentLabel}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
        accessibilityLabel={`${props.window.label} usage ${percentLabel}`}
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: track }}
      >
        <View
          className="h-full rounded-full"
          style={{ width: `${percent}%`, backgroundColor: fill }}
        />
      </View>
    </View>
  );
}

/**
 * Read-only "Provider usage" settings section: one block per provider instance
 * (across every connected environment) that reports live per-plan usage
 * windows. Providers whose driver exposes no machine-readable usage contribute
 * nothing, and the whole section hides when no provider reports any — no fake
 * bars. Data rides the existing server-config subscription, so the bars update
 * live as new rate-limit telemetry arrives.
 */
export function ProviderUsageSection() {
  const configs = useServerConfigs();

  const rows = useMemo(() => {
    const collected: Array<{
      readonly key: string;
      readonly label: string;
      readonly usage: ReadonlyArray<ServerProviderUsageWindow>;
    }> = [];
    for (const [environmentId, config] of configs) {
      for (const provider of config.providers) {
        if (provider.usage !== undefined && provider.usage.length > 0) {
          collected.push({
            key: `${environmentId}:${provider.instanceId}`,
            label: provider.displayName?.trim() || String(provider.driver),
            usage: provider.usage,
          });
        }
      }
    }
    return collected;
  }, [configs]);

  if (rows.length === 0) return null;

  return (
    <SettingsSection title="Provider usage">
      {rows.map((row, index) => (
        <View
          key={row.key}
          className={index === 0 ? "gap-2.5 p-4" : "gap-2.5 border-t border-border-subtle p-4"}
        >
          <Text className="text-lg text-foreground" numberOfLines={1}>
            {row.label}
          </Text>
          {row.usage.map((window) => (
            <ProviderUsageWindowRow key={window.id} window={window} />
          ))}
        </View>
      ))}
    </SettingsSection>
  );
}
