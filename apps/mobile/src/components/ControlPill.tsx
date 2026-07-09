import { MenuView } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, useColorScheme, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useThemeColor } from "../lib/useThemeColor";

import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";
import { MaterialMenuAndroid } from "./MaterialMenuAndroid";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
  /** Tighter 40px circle (Material composer) instead of the default 44px. */
  readonly compact?: boolean;
}) {
  const variant = props.variant ?? "circle";
  const isAndroid = Platform.OS === "android";
  const circleSize = props.compact ? "h-10 w-10" : "h-11 w-11";

  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const accentForeground = useThemeColor("--color-accent-foreground");
  // Android idle send reads as a low-emphasis tonal accent (M3), not grey — so
  // the send arrow stays "the material color" even when disabled.
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? isAndroid
          ? accentForeground
          : iconSubtle
        : primaryFg
      : variant === "danger"
        ? dangerFg
        : iconColor;

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);
  const containerClassName = cn(
    isCircle
      ? `${circleSize} items-center justify-center rounded-full`
      : variant === "primary"
        ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
        : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5",
    variant === "primary"
      ? props.disabled
        ? isAndroid
          ? "bg-primary-tonal"
          : "bg-subtle-strong"
        : "bg-primary"
      : variant === "danger"
        ? "bg-danger"
        : "bg-subtle",
  );
  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? isAndroid
          ? "text-accent-foreground"
          : "text-foreground-muted"
        : "text-primary-foreground"
      : "",
  );

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      // Light selection tick on tap; menu/long-press haptics live in their menus.
      onPress={
        props.onPress
          ? () => {
              void Haptics.selectionAsync();
              props.onPress?.();
            }
          : undefined
      }
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  );
}

export function ControlPillMenu(
  props: Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> & {
    readonly children: ReactNode;
  },
) {
  const isDarkMode = useColorScheme() === "dark";

  // Android's native PopupMenu surface is unstyleable from JS (square corners,
  // flat gray). Render a Material 3 popover instead; iOS keeps the native
  // UIMenu / liquid-glass MenuView untouched.
  if (Platform.OS === "android") {
    const { children, ...menuProps } = props;
    return (
      <MaterialMenuAndroid
        actions={menuProps.actions}
        title={menuProps.title}
        isAnchoredToRight={menuProps.isAnchoredToRight}
        shouldOpenOnLongPress={menuProps.shouldOpenOnLongPress}
        onPressAction={menuProps.onPressAction}
        onOpenMenu={menuProps.onOpenMenu}
        onCloseMenu={menuProps.onCloseMenu}
      >
        {children}
      </MaterialMenuAndroid>
    );
  }

  return (
    <MenuView {...props} themeVariant={isDarkMode ? "dark" : "light"}>
      {props.children}
    </MenuView>
  );
}
