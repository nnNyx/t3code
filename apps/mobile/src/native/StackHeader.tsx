import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import type { ColorValue } from "react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MaterialMenuAndroid } from "../components/MaterialMenuAndroid";
import { useThemeColor } from "../lib/useThemeColor";

export {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
  type NativeHeaderScrollEdgeEffects,
  type NativeTopScrollEdgeEffect,
} from "./scrollEdgeEffects";

export type AppNativeStackNavigationOptions = Omit<
  NativeStackNavigationOptions,
  "headerTintColor" | "unstable_headerLeftItems" | "unstable_headerRightItems"
> & {
  readonly headerTintColor?: string | ColorValue;
  readonly unstable_headerCenterItems?: unknown;
  readonly unstable_headerLeftItems?: unknown;
  readonly unstable_headerRightItems?: unknown;
  readonly unstable_headerSubtitle?: unknown;
  readonly unstable_headerToolbarItems?: unknown;
  readonly unstable_navigationItemStyle?: unknown;
};

function useNativeStackNavigation(): NativeStackNavigationProp<ParamListBase> | null {
  return useNavigation<NativeStackNavigationProp<ParamListBase>>();
}

function normalizeScreenOptions(
  options: AppNativeStackNavigationOptions | undefined,
): NativeStackNavigationOptions | undefined {
  if (!options) {
    return options;
  }

  const normalized = { ...options } as NativeStackNavigationOptions & {
    unstable_navigationItemStyle?: unknown;
    unstable_headerCenterItems?: unknown;
    unstable_headerSubtitle?: unknown;
    unstable_headerToolbarItems?: unknown;
  };

  if (normalized.headerTintColor !== undefined) {
    normalized.headerTintColor = String(normalized.headerTintColor);
  }

  return normalized as NativeStackNavigationOptions;
}

function optionsSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "undefined":
      return "undefined";
    case "function":
      // Header factories are frequently recreated inline. Their source is
      // stable across equivalent renders, while a reference comparison would
      // make navigation.setOptions re-enter the navigator indefinitely.
      return `function:${Function.prototype.toString.call(value)}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "bigint":
      return `bigint:${String(value)}`;
    case "object": {
      const object = value as object;
      if (seen.has(object)) return "[circular]";
      seen.add(object);
      if (Array.isArray(value)) {
        return `[${value.map((entry) => optionsSignature(entry, seen)).join(",")}]`;
      }
      // React refs carry mutable native instances that must not make static
      // screen options appear different after every render.
      if ("current" in object) return "[ref]";
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${optionsSignature((value as Record<string, unknown>)[key], seen)}`,
        )
        .join(",")}}`;
    }
  }
  return String(value);
}

function stabilizeOptionFunctions(
  value: unknown,
  path: string,
  latestFunctions: Map<string, (...args: unknown[]) => unknown>,
  wrappers: Map<string, (...args: unknown[]) => unknown>,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "function") {
    latestFunctions.set(path, value as (...args: unknown[]) => unknown);
    let wrapper = wrappers.get(path);
    if (!wrapper) {
      wrapper = (...args: unknown[]) => {
        return latestFunctions.get(path)?.(...args);
      };
      wrappers.set(path, wrapper);
    }
    return wrapper;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((entry, index) =>
      stabilizeOptionFunctions(entry, `${path}[${index}]`, latestFunctions, wrappers, seen),
    );
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value) || "current" in value) return value;
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        stabilizeOptionFunctions(entry, `${path}.${key}`, latestFunctions, wrappers, seen),
      ]),
    );
  }
  return value;
}

export function NativeStackScreenOptions(props: {
  readonly options?: AppNativeStackNavigationOptions;
  readonly listeners?: Record<string, (event: never) => void>;
  readonly name?: string;
}) {
  const navigation = useNativeStackNavigation();
  const lastAppliedOptionsSignatureRef = useRef<string | undefined>(undefined);
  const latestOptionFunctionsRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const optionFunctionWrappersRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const normalizedOptions = useMemo(() => normalizeScreenOptions(props.options), [props.options]);
  const stableOptions = normalizedOptions
    ? (stabilizeOptionFunctions(
        normalizedOptions,
        "options",
        latestOptionFunctionsRef.current,
        optionFunctionWrappersRef.current,
      ) as NativeStackNavigationOptions)
    : undefined;

  useLayoutEffect(() => {
    if (!navigation || !stableOptions) {
      return;
    }
    const signature = optionsSignature(stableOptions);
    // Avoid re-entering navigation state when semantically equal options are
    // reapplied every layout (common when callers pass unstable object literals).
    if (lastAppliedOptionsSignatureRef.current === signature) {
      return;
    }
    lastAppliedOptionsSignatureRef.current = signature;
    navigation.setOptions(stableOptions);
  }, [navigation, stableOptions]);

  useEffect(() => {
    if (!navigation || !props.listeners) {
      return;
    }
    const subscriptions = Object.entries(props.listeners).map(([eventName, listener]) =>
      navigation.addListener(eventName as never, listener as never),
    );
    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    };
  }, [navigation, props.listeners]);

  return null;
}

function labelFromChildren(children: ReactNode): string {
  const parts: string[] = [];
  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      parts.push(String(child));
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      parts.push(labelFromChildren(child.props.children));
    }
  });
  return parts.join("");
}

type NativeStackHeaderIcon = NonNullable<
  Extract<NativeStackHeaderItem, { type: "button" }>["icon"]
>;
type NativeStackOptionsWithToolbar = NativeStackNavigationOptions & {
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

function iconFromProp(icon: unknown): NativeStackHeaderIcon | undefined {
  if (typeof icon !== "string") {
    return undefined;
  }
  return { type: "sfSymbol", name: icon as never };
}

type ToolbarElementProps = Record<string, unknown> & { readonly children?: ReactNode };

function elementTypeName(element: ReactElement): string | undefined {
  const type = element.type;
  if (typeof type === "function") {
    return (type as { displayName?: string; name?: string }).displayName ?? type.name;
  }
  return undefined;
}

function convertMenuAction(
  element: ReactElement<ToolbarElementProps>,
): NativeStackHeaderItemMenu["menu"]["items"][number] | null {
  const typeName = elementTypeName(element);
  if (typeName === "NativeHeaderToolbarMenuAction") {
    const label = labelFromChildren(element.props.children);
    return {
      type: "action",
      label,
      description: typeof element.props.subtitle === "string" ? element.props.subtitle : undefined,
      disabled: Boolean(element.props.disabled),
      icon: iconFromProp(element.props.icon),
      onPress:
        typeof element.props.onPress === "function"
          ? (element.props.onPress as () => void)
          : () => undefined,
      state: element.props.isOn === true ? "on" : undefined,
      destructive: Boolean(element.props.destructive),
      discoverabilityLabel:
        typeof element.props.discoverabilityLabel === "string"
          ? element.props.discoverabilityLabel
          : undefined,
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "submenu",
      label:
        typeof element.props.title === "string"
          ? element.props.title
          : labelFromChildren(element.props.children),
      icon: iconFromProp(element.props.icon),
      inline: Boolean(element.props.inline),
      items: collectMenuItems(element.props.children),
    };
  }

  return null;
}

function collectMenuItems(children: ReactNode): NativeStackHeaderItemMenu["menu"]["items"] {
  const items: NativeStackHeaderItemMenu["menu"]["items"] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ToolbarElementProps>(child)) {
      return;
    }
    const item = convertMenuAction(child);
    if (item) {
      items.push(item);
      return;
    }
    items.push(...collectMenuItems(child.props.children));
  });
  return items;
}

function convertToolbarChild(child: ReactNode): NativeStackHeaderItem | null {
  if (!isValidElement<ToolbarElementProps>(child)) {
    return null;
  }

  const typeName = elementTypeName(child);
  if (typeName === "NativeHeaderToolbarButton") {
    return {
      type: "button",
      label: typeof child.props.label === "string" ? child.props.label : "",
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      onPress:
        typeof child.props.onPress === "function"
          ? (child.props.onPress as () => void)
          : () => undefined,
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "menu",
      label: typeof child.props.title === "string" ? child.props.title : "",
      accessibilityLabel:
        typeof child.props.accessibilityLabel === "string"
          ? child.props.accessibilityLabel
          : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      menu: {
        title: typeof child.props.title === "string" ? child.props.title : undefined,
        items: collectMenuItems(child.props.children),
      },
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarSpacer") {
    return {
      type: "spacing",
      spacing: typeof child.props.width === "number" ? child.props.width : 8,
    };
  }

  return null;
}

function collectToolbarItems(children: ReactNode): NativeStackHeaderItem[] {
  const items: NativeStackHeaderItem[] = [];
  Children.forEach(children, (child) => {
    const item = convertToolbarChild(child);
    if (item) {
      items.push(item);
    }
  });
  return items;
}

/* ─── Android toolbar rendering ──────────────────────────────────────────
 * react-native-screens' unstable_header*Items are iOS-only. On Android we
 * render real UI instead: bottom placement becomes a floating action bar and
 * left/right placement map to the native-stack header's headerLeft/headerRight
 * slots. The iOS path (setOptions with unstable_* items) is left untouched. */

/** Content height of the Android floating bottom action bar (excludes the
 *  bottom safe-area inset, added as padding). Consumers that render a bottom
 *  NativeHeaderToolbar must reserve this much bottom space in their scroll
 *  content so it is not obscured. */
export const ANDROID_BOTTOM_TOOLBAR_HEIGHT = 56;

/** SF Symbol → Material Symbol name for every button/menu-anchor icon a
 *  NativeHeaderToolbar consumer uses. expo-symbols draws Material Symbols on
 *  Android; a bare SF Symbol string renders nothing there. Kept intentionally
 *  small — only the icons that actually reach an Android SymbolView. */
const SF_TO_MATERIAL_ICON: Readonly<Record<string, AndroidSymbol>> = {
  "arrow.clockwise": "refresh",
  "arrow.up.left.and.arrow.down.right": "open_in_full",
  "chevron.left": "chevron_left",
  ellipsis: "more_horiz",
  folder: "folder",
  gearshape: "settings",
  "line.3.horizontal.decrease": "filter_list",
  "line.3.horizontal.decrease.circle": "filter_list",
  "line.3.horizontal.decrease.circle.fill": "filter_alt",
  plus: "add",
  "point.topleft.down.curvedto.point.bottomright.up": "account_tree",
  "qrcode.viewfinder": "qr_code_scanner",
  "sidebar.left": "dock_to_left",
  "sidebar.right": "dock_to_right",
  "square.and.pencil": "edit_square",
  terminal: "terminal",
  xmark: "close",
};

function androidSymbolName(
  icon: NativeStackHeaderIcon | undefined,
): { readonly ios: SFSymbol; readonly android: AndroidSymbol } | null {
  const name = (icon as { readonly name?: unknown } | undefined)?.name;
  if (typeof name !== "string") {
    return null;
  }
  return { ios: name as SFSymbol, android: SF_TO_MATERIAL_ICON[name] ?? "more_horiz" };
}

type SerializedMenuItem = NativeStackHeaderItemMenu["menu"]["items"][number];

/** Convert the serialized menu tree into @react-native-menu/menu actions,
 *  registering each leaf's onPress in `handlers` keyed by a generated id.
 *  Inline submenus flatten into the parent level: this matches iOS's inline
 *  semantics and sidesteps Android's single-level submenu nesting limit. */
function buildAndroidMenuActions(
  items: readonly SerializedMenuItem[],
  handlers: Map<string, () => void>,
  prefix: string,
): MenuAction[] {
  const actions: MenuAction[] = [];
  items.forEach((item, index) => {
    const id = `${prefix}.${index}`;
    if (item.type === "action") {
      if (typeof item.onPress === "function") {
        handlers.set(id, item.onPress);
      }
      actions.push({
        id,
        title: item.label,
        subtitle: item.description,
        // Android checkmarks the "on" item; leaving others unset (not "off")
        // keeps them slot-free, mirroring iOS.
        state: item.state === "on" ? "on" : undefined,
        attributes: {
          disabled: Boolean(item.disabled),
          destructive: Boolean(item.destructive),
        },
      });
      return;
    }
    if (item.inline) {
      actions.push(...buildAndroidMenuActions(item.items, handlers, id));
      return;
    }
    actions.push({
      id,
      title: item.label,
      subactions: buildAndroidMenuActions(item.items, handlers, id),
    });
  });
  return actions;
}

function AndroidToolbarPressable(props: {
  readonly icon?: NativeStackHeaderIcon;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly tintColor: ColorValue;
}) {
  const symbol = androidSymbolName(props.icon);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        justifyContent: "center",
        minWidth: 40,
        height: 40,
        paddingHorizontal: 6,
        opacity: props.disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      {symbol ? <SymbolView name={symbol} size={24} tintColor={props.tintColor} /> : null}
    </Pressable>
  );
}

function AndroidToolbarMenu(props: {
  readonly item: Extract<NativeStackHeaderItem, { type: "menu" }>;
  readonly tintColor: ColorValue;
  readonly anchoredToRight?: boolean;
}) {
  const handlers = new Map<string, () => void>();
  const actions = buildAndroidMenuActions(props.item.menu.items, handlers, "menu");
  return (
    <MaterialMenuAndroid
      title={props.item.menu.title}
      actions={actions}
      isAnchoredToRight={props.anchoredToRight}
      onPressAction={({ nativeEvent }) => handlers.get(nativeEvent.event)?.()}
    >
      <AndroidToolbarPressable
        icon={props.item.icon}
        accessibilityLabel={props.item.accessibilityLabel}
        disabled={props.item.disabled}
        tintColor={props.tintColor}
      />
    </MaterialMenuAndroid>
  );
}

function AndroidToolbarItem(props: {
  readonly item: NativeStackHeaderItem;
  readonly variant: "bottom" | "inline";
  readonly tintColor: ColorValue;
  readonly anchoredToRight?: boolean;
}) {
  const { item } = props;
  if (item.type === "button") {
    return (
      <AndroidToolbarPressable
        icon={item.icon}
        accessibilityLabel={item.accessibilityLabel}
        disabled={item.disabled}
        onPress={item.onPress}
        tintColor={item.tintColor ?? props.tintColor}
      />
    );
  }
  if (item.type === "menu") {
    return (
      <AndroidToolbarMenu
        item={item}
        tintColor={item.tintColor ?? props.tintColor}
        anchoredToRight={props.anchoredToRight}
      />
    );
  }
  // Spacers carry layout meaning only inline; the bottom bar uses space-between
  // and drops them.
  if (item.type === "spacing" && props.variant === "inline") {
    return <View style={{ width: item.spacing }} />;
  }
  return null;
}

function AndroidHeaderItems(props: {
  readonly items: readonly NativeStackHeaderItem[];
  readonly anchoredToRight?: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 4 }}>
      {props.items.map((item, index) => (
        <AndroidToolbarItem
          key={index}
          item={item}
          variant="inline"
          tintColor={iconColor}
          anchoredToRight={props.anchoredToRight}
        />
      ))}
    </View>
  );
}

function AndroidBottomToolbar(props: { readonly items: readonly NativeStackHeaderItem[] }) {
  const insets = useSafeAreaInsets();
  const cardColor = useThemeColor("--color-card");
  const borderColor = useThemeColor("--color-border");
  const iconColor = useThemeColor("--color-icon");
  const actionable = props.items.filter((item) => item.type === "button" || item.type === "menu");
  if (actionable.length === 0) {
    return null;
  }
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        // Rendered before the screen body in the tree, so lift it above the
        // (opaque) list: elevation orders + shadows on Android, zIndex backs it
        // up at the Yoga level.
        zIndex: 10,
        elevation: 8,
        height: ANDROID_BOTTOM_TOOLBAR_HEIGHT + insets.bottom,
        paddingBottom: insets.bottom,
        paddingHorizontal: 12,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: cardColor,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: borderColor,
      }}
    >
      {actionable.map((item, index) => (
        <AndroidToolbarItem key={index} item={item} variant="bottom" tintColor={iconColor} />
      ))}
    </View>
  );
}

function NativeHeaderToolbarRoot(props: {
  readonly placement?: "left" | "right" | "bottom";
  readonly children?: ReactNode;
}) {
  const navigation = useNativeStackNavigation();
  const items = useMemo(() => collectToolbarItems(props.children), [props.children]);
  const isIOS = Platform.OS === "ios";

  useEffect(() => {
    if (!navigation) {
      return;
    }
    if (isIOS) {
      if (props.placement === "bottom") {
        navigation.setOptions({
          unstable_headerToolbarItems: () => items,
        } as NativeStackOptionsWithToolbar);
        return () => {
          navigation.setOptions({
            unstable_headerToolbarItems: () => [],
          } as NativeStackOptionsWithToolbar);
        };
      }
      if (props.placement === "left") {
        navigation.setOptions({ unstable_headerLeftItems: () => items });
        return () => {
          navigation.setOptions({ unstable_headerLeftItems: () => [] });
        };
      }
      navigation.setOptions({ unstable_headerRightItems: () => items });
      return () => {
        navigation.setOptions({ unstable_headerRightItems: () => [] });
      };
    }
    // Android: bottom placement renders as a floating bar (returned below);
    // left/right map to the native-stack header slots.
    if (props.placement === "bottom") {
      return;
    }
    if (props.placement === "left") {
      navigation.setOptions({ headerLeft: () => <AndroidHeaderItems items={items} /> });
      return () => {
        navigation.setOptions({ headerLeft: undefined });
      };
    }
    navigation.setOptions({
      headerRight: () => <AndroidHeaderItems items={items} anchoredToRight />,
    });
    return () => {
      navigation.setOptions({ headerRight: undefined });
    };
  }, [isIOS, items, navigation, props.placement]);

  if (!isIOS && props.placement === "bottom") {
    return <AndroidBottomToolbar items={items} />;
  }
  return null;
}

function NativeHeaderToolbarButton(_props: {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
}) {
  return null;
}
NativeHeaderToolbarButton.displayName = "NativeHeaderToolbarButton";

function NativeHeaderToolbarMenu(_props: {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly inline?: boolean;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly title?: string;
}) {
  return null;
}
NativeHeaderToolbarMenu.displayName = "NativeHeaderToolbarMenu";

function NativeHeaderToolbarMenuAction(_props: {
  readonly children?: ReactNode;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly discoverabilityLabel?: string;
  readonly icon?: string;
  readonly isOn?: boolean;
  readonly onPress?: () => void;
  readonly subtitle?: string;
}) {
  return null;
}
NativeHeaderToolbarMenuAction.displayName = "NativeHeaderToolbarMenuAction";

function NativeHeaderToolbarLabel(_props: { readonly children?: ReactNode }) {
  return null;
}
NativeHeaderToolbarLabel.displayName = "NativeHeaderToolbarLabel";

function NativeHeaderToolbarSpacer(_props: {
  readonly sharesBackground?: boolean;
  readonly width?: number;
}) {
  return null;
}
NativeHeaderToolbarSpacer.displayName = "NativeHeaderToolbarSpacer";

function NativeHeaderToolbarSearchBarSlot() {
  return null;
}
NativeHeaderToolbarSearchBarSlot.displayName = "NativeHeaderToolbarSearchBarSlot";

export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
