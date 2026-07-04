import type { Material3Scheme } from "@pchmn/expo-material3-theme";

export const BRAND_ACCENT_SOURCE = "#155dfc";

function alpha(hex: string, opacity: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    return hex;
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export function resolveMaterialAccentVariables(
  scheme: Material3Scheme,
  mode: "light" | "dark",
): Record<`--color-${string}`, string> {
  const action = mode === "dark" ? scheme.primaryContainer : scheme.primary;
  const actionForeground = mode === "dark" ? scheme.onPrimaryContainer : scheme.onPrimary;
  const link = mode === "dark" ? scheme.inversePrimary : scheme.primary;

  return {
    "--color-primary": action,
    "--color-primary-foreground": actionForeground,
    "--color-primary-shadow": alpha(action, mode === "dark" ? 0.26 : 0.22),
    "--color-ring": link,
    "--color-accent": alpha(action, mode === "dark" ? 0.18 : 0.1),
    "--color-accent-foreground": link,
    "--color-accent-border": alpha(action, mode === "dark" ? 0.32 : 0.24),
    "--color-selection": alpha(action, mode === "dark" ? 0.22 : 0.16),
    "--color-md-link": link,
    "--color-user-bubble": action,
    "--color-user-bubble-foreground": actionForeground,
    "--color-switch-active": mode === "dark" ? scheme.tertiaryContainer : scheme.tertiary,
  };
}
