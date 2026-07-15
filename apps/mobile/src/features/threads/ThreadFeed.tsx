import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";

import { useEnvironmentPullRefresh } from "../../state/use-environment-pull-refresh";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { SymbolView } from "expo-symbols";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import ImageViewing from "react-native-image-viewing";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  ZoomIn,
  ZoomOut,
  type SharedValue,
} from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { useFontFamily } from "../../lib/useFontFamily";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from "../review/reviewCommentSelection";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { cn } from "../../lib/cn";
import { deriveCenteredContentHorizontalPadding, type LayoutVariant } from "../../lib/layout";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { ThreadWorkGroupToggle, ThreadWorkLog } from "./thread-work-log";
import { shouldPlayEntrance } from "./threadEntranceAnimation";
import {
  deriveJumpToBottomState,
  distanceFromEndForScrollEvent,
  nextFollowStream,
  nextNewActivityWhileAway,
  resolveEndScrollMaintenance,
  shouldArmSendAnchorAnimation,
  SEND_ANCHOR_ANIMATION_WINDOW_MS,
} from "./threadScrollMaintenance";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import { useAssetUrl } from "../../state/assets";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";

const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
function formatMessageTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp);
}

// Rows shift when content above them grows (streaming text, work-log folds);
// animating the container position turns those jumps into slides.
const FEED_ITEM_LAYOUT_TRANSITION = LinearTransition.duration(180);

export interface ThreadFeedProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly onLoadEarlier: () => void;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestTurn: ThreadFeedLatestTurn | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly contentMaxWidth?: number;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachmentId,
  });

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(uri)}>
      <Image source={{ uri }} className={props.className} resizeMode="cover" />
    </TouchableOpacity>
  );
}

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
}

const failedMarkdownFaviconHosts = new Set<string>();
const markdownLinkStyles = StyleSheet.create({
  inlineIcon: {
    width: 14,
    height: 14,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
  favicon: {
    borderRadius: 3,
  },
});

const MARKDOWN_MONO_FONT = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode;
  readonly color: string;
  readonly host: string;
  readonly href: string;
}) {
  const [failed, setFailed] = useState(() => failedMarkdownFaviconHosts.has(props.host));

  return (
    <NativeText
      className="font-sans"
      onPress={() => {
        void Linking.openURL(props.href);
      }}
      style={{
        color: props.color,
        textDecorationLine: "none",
      }}
    >
      {!failed ? (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.host)}&sz=32`,
          }}
          style={[markdownLinkStyles.inlineIcon, markdownLinkStyles.favicon]}
          onError={() => {
            failedMarkdownFaviconHosts.add(props.host);
            setFailed(true);
          }}
        />
      ) : (
        <NativeText style={{ color: props.color }}>{" ◉ "}</NativeText>
      )}
      {props.children}
    </NativeText>
  );
});

// Ported from upstream PR pingdotgg/t3code#3579 by @juliusmarminge ("Use Shiki
// for markdown code blocks"). Syntax-highlighted, horizontally scrollable code
// block for the JS markdown renderer (Android; iOS renders via the native
// SelectableMarkdownText.ios path). Highlighting is async: until the Shiki
// result resolves the block shows plain themed text, so streaming assistant
// tokens never flicker. Adapted for our tree: themed colors stay driven by the
// caller's --color-md-* tokens; only per-token foreground/weight comes from
// Shiki. Reconcile against PR #3579 on future upstream merges.
function MarkdownCodeBlock(props: {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly content: string;
  readonly copyTintColor: ColorValue;
  readonly headerTextColor: string;
  readonly fontSize: number;
  readonly highlightCode: boolean;
  readonly language?: string | null;
  readonly lineHeight: number;
  readonly textColor: string;
  readonly theme: ReviewDiffTheme;
}) {
  const content = props.content.replace(/\n$/, "");
  const languageLabel = props.language?.trim() || "text";
  const highlighted = useMarkdownCodeHighlight({
    code: content,
    enabled: props.highlightCode && Boolean(props.language?.trim()),
    language: props.language,
    theme: props.theme,
  });
  let tokenOffset = 0;

  return (
    <View
      style={{
        alignSelf: "stretch",
        backgroundColor: props.backgroundColor,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: props.borderColor,
        marginVertical: 12,
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: props.borderColor,
          paddingLeft: 14,
          paddingRight: 6,
          paddingVertical: 4,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <NativeText
          numberOfLines={1}
          style={{
            flex: 1,
            color: props.headerTextColor,
            fontFamily: MARKDOWN_MONO_FONT,
            fontSize: props.fontSize,
            opacity: 0.7,
            textTransform: "uppercase",
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {languageLabel}
        </NativeText>
        <CopyTextButton
          accessibilityLabel="Copy code"
          text={content}
          tintColor={props.copyTintColor}
          buttonSize={32}
          iconSize={16}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
      >
        <NativeText
          selectable
          style={{
            color: props.textColor,
            fontFamily: MARKDOWN_MONO_FONT,
            fontSize: props.fontSize,
            lineHeight: props.lineHeight,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {highlighted
            ? highlighted.map((line, lineIndex) => {
                const lineStartOffset = tokenOffset;
                const lineText = line.map((token) => token.content).join("");
                const renderedLine = (
                  <NativeText key={`line:${lineStartOffset}:${lineText}`}>
                    {line.map((token) => {
                      const startOffset = tokenOffset;
                      tokenOffset += token.content.length;
                      const fontStyle =
                        token.fontStyle !== null && (token.fontStyle & 1) === 1
                          ? ("italic" as const)
                          : ("normal" as const);
                      const fontWeight =
                        token.fontStyle !== null && (token.fontStyle & 2) === 2
                          ? ("700" as const)
                          : ("400" as const);

                      return (
                        <NativeText
                          key={`${startOffset}:${token.content}:${token.color ?? ""}:${
                            token.fontStyle ?? ""
                          }`}
                          style={{
                            color: token.color ?? props.textColor,
                            fontFamily: MARKDOWN_MONO_FONT,
                            fontStyle,
                            fontWeight,
                          }}
                        >
                          {token.content}
                        </NativeText>
                      );
                    })}
                    {lineIndex + 1 < highlighted.length ? "\n" : ""}
                  </NativeText>
                );
                if (lineIndex + 1 < highlighted.length) {
                  tokenOffset += 1;
                }
                return renderedLine;
              })
            : content}
        </NativeText>
      </ScrollView>
    </View>
  );
}

function useReviewCommentColors(): ReviewCommentColors {
  const background = useThemeColor("--color-card");
  const border = useThemeColor("--color-border");
  const mutedBackground = useThemeColor("--color-subtle");
  const text = useThemeColor("--color-foreground");
  const mutedText = useThemeColor("--color-foreground-muted");
  const codeBackground = useThemeColor("--color-md-code-bg");

  return useMemo(
    () => ({
      background,
      border,
      mutedBackground,
      text,
      mutedText,
      codeBackground,
    }),
    [background, border, codeBackground, mutedBackground, mutedText, text],
  );
}

function useMarkdownStyles(onLinkPress: (href: string) => void): MarkdownStyleSets {
  const { appearance } = useAppearancePreferences();
  const colorScheme = useColorScheme();
  const themeMode: ReviewDiffTheme = colorScheme === "dark" ? "dark" : "light";
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const markdownBodyColor = String(useThemeColor("--color-md-body"));
  const markdownStrongColor = String(useThemeColor("--color-md-strong"));
  const markdownLinkColor = String(useThemeColor("--color-md-link"));
  const markdownBlockquoteBg = String(useThemeColor("--color-md-blockquote-bg"));
  const markdownBlockquoteBorder = String(useThemeColor("--color-md-blockquote-border"));
  const markdownCodeBg = String(useThemeColor("--color-md-code-bg"));
  const markdownCodeText = String(useThemeColor("--color-md-code-text"));
  const markdownHrColor = String(useThemeColor("--color-md-hr"));
  const markdownUserBodyColor = String(useThemeColor("--color-user-bubble-foreground"));
  const markdownUserBodyMutedColor = String(useThemeColor("--color-user-bubble-foreground-muted"));
  const markdownUserCodeBg = String(useThemeColor("--color-md-user-code-bg"));
  const markdownUserCodeText = String(useThemeColor("--color-md-user-code-text"));
  const markdownUserFenceBg = String(useThemeColor("--color-md-user-fence-bg"));
  const markdownUserFenceText = String(useThemeColor("--color-md-user-fence-text"));
  const inlineSkillForeground = String(useThemeColor("--color-inline-skill-foreground"));
  const iconSubtleColor = String(useThemeColor("--color-icon-subtle"));
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const markdownInlineCodeText = markdownBodyColor;
    const markdownUserInlineCodeText = markdownUserBodyMutedColor;

    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
        surfaceLight: markdownBlockquoteBg,
        accent: markdownLinkColor,
        tableBorder: markdownHrColor,
        tableHeader: markdownBlockquoteBg,
        tableHeaderText: markdownStrongColor,
        tableRowOdd: "transparent",
        tableRowEven: "transparent",
      },
      spacing: {
        xs: 4,
        s: 4,
        m: 8,
        l: 8,
        xl: 16,
      },
      fontSizes: {
        s: markdownFontSizes.s,
        m: markdownFontSizes.m,
        h1: markdownFontSizes.h1,
        h2: markdownFontSizes.h2,
        h3: markdownFontSizes.h3,
        h4: markdownFontSizes.h4,
        h5: markdownFontSizes.h5,
        h6: markdownFontSizes.h6,
      },
      fontFamilies: {
        regular: regularFontFamily,
        heading: boldFontFamily,
        mono: MARKDOWN_MONO_FONT,
      },
      headingWeight: "700",
      borderRadius: {
        s: 4,
        m: 8,
        l: 12,
      },
      showCodeLanguage: false,
    };

    const baseStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 4, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: markdownFontSizes.bodyLineHeight },
      bold: {
        fontWeight: "700",
        color: markdownStrongColor,
        fontFamily: boldFontFamily,
      },
      italic: { fontStyle: "italic" },
      link: {
        color: markdownLinkColor,
        textDecorationLine: "underline" as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: markdownBlockquoteBorder,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 10,
      },
      heading: {
        fontFamily: boldFontFamily,
        color: markdownStrongColor,
        marginTop: 18,
        marginBottom: 8,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    };

    const createMarkdownRenderers = (
      inlineTextColor: string,
      inlineCodeTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
      copyTintColor: ColorValue,
      preserveSoftBreaks: boolean,
      highlightCode: boolean,
    ): CustomRenderers => ({
      link: ({ children, href = "" }) => {
        const presentation = resolveMarkdownLinkPresentation(href);
        if (presentation.kind === "file") {
          return (
            <NativeText
              className="font-t3-bold"
              onPress={() => onLinkPress(href)}
              style={{ color: inlineTextColor }}
            >
              <Image
                source={markdownFileIconSource(presentation.icon)}
                style={markdownLinkStyles.inlineIcon}
              />
              {presentation.label}
            </NativeText>
          );
        }
        if (presentation.kind === "external") {
          return (
            <MarkdownExternalLink
              href={presentation.href}
              host={presentation.host}
              color={markdownLinkColor}
            >
              {children}
            </MarkdownExternalLink>
          );
        }
        const linkHref = presentation.href;
        return (
          <NativeText
            className="underline"
            onPress={
              linkHref
                ? () => {
                    void Linking.openURL(linkHref);
                  }
                : undefined
            }
            style={{ color: markdownLinkColor }}
          >
            {children}
          </NativeText>
        );
      },
      list: ({ node, Renderer, ordered = false, start = 1 }) => (
        <View className="mt-0.5 mb-2">
          {node.children?.map((child, index) => {
            const childKey = `${child.type}:${child.beg ?? "unknown"}:${child.end ?? "unknown"}`;
            if (child.type === "task_list_item") {
              return (
                <Renderer key={childKey} node={child} depth={1} inListItem parentIsText={false} />
              );
            }
            return (
              <View className="mb-[3px] flex-row items-start" key={childKey}>
                <NativeText
                  className="font-sans"
                  style={{
                    width: ordered ? 22 : 12,
                    marginRight: 5,
                    color: inlineTextColor,
                    fontSize: markdownFontSizes.m,
                    lineHeight: markdownFontSizes.bodyLineHeight,
                    textAlign: ordered ? "right" : "center",
                  }}
                >
                  {ordered ? `${start + index}.` : "•"}
                </NativeText>
                <View className="min-w-0 flex-1">
                  <Renderer node={child} depth={1} inListItem parentIsText={false} />
                </View>
              </View>
            );
          })}
        </View>
      ),
      code_inline: ({ content }) => {
        const value = content ?? "";
        return (
          <NativeText
            className="font-mono"
            style={{
              color: inlineCodeTextColor,
              fontFamily: MARKDOWN_MONO_FONT,
              fontSize: markdownFontSizes.codeBlockFontSize,
              lineHeight: markdownFontSizes.bodyLineHeight,
              ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
            }}
          >
            {value}
          </NativeText>
        );
      },
      ...(preserveSoftBreaks
        ? {
            soft_break: () => <NativeText>{"\n"}</NativeText>,
          }
        : {}),
      code_block: ({ content = "", language }) => (
        <MarkdownCodeBlock
          backgroundColor={blockBackgroundColor}
          borderColor={markdownHrColor}
          content={content}
          copyTintColor={copyTintColor}
          fontSize={markdownFontSizes.codeBlockFontSize}
          headerTextColor={blockTextColor}
          highlightCode={highlightCode}
          language={language}
          lineHeight={markdownFontSizes.codeBlockLineHeight}
          textColor={blockTextColor}
          theme={themeMode}
        />
      ),
    });

    const userTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        text: markdownUserBodyColor,
        heading: markdownUserBodyColor,
        link: markdownUserBodyColor,
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    };
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
      bold: {
        fontWeight: "700",
        color: markdownUserBodyColor,
        fontFamily: boldFontFamily,
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
        marginTop: 8,
        marginBottom: 4,
      },
      link: {
        color: markdownUserBodyColor,
        textDecorationLine: "underline" as const,
      },
    };

    const assistantTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        code: markdownCodeText,
        codeBackground: markdownCodeBg,
        border: markdownCodeBg,
      },
    };
    const assistantStyles: NodeStyleOverrides = {
      ...baseStyles,
    };

    return {
      user: {
        theme: userTheme,
        styles: userStyles,
        renderers: createMarkdownRenderers(
          markdownUserCodeText,
          markdownUserInlineCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
          markdownUserBodyMutedColor,
          true,
          false,
        ),
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          inlineCodeColor: markdownUserInlineCodeText,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileTextColor: markdownUserBodyColor,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createMarkdownRenderers(
          markdownCodeText,
          markdownInlineCodeText,
          markdownCodeBg,
          markdownCodeText,
          iconSubtleColor,
          false,
          true,
        ),
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          inlineCodeColor: markdownInlineCodeText,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileTextColor: markdownCodeText,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
    };
  }, [
    boldFontFamily,
    iconSubtleColor,
    inlineSkillForeground,
    markdownBlockquoteBg,
    markdownBlockquoteBorder,
    markdownBodyColor,
    markdownCodeBg,
    markdownCodeText,
    markdownFontSizes,
    markdownHrColor,
    markdownLinkColor,
    markdownStrongColor,
    markdownUserBodyColor,
    markdownUserBodyMutedColor,
    markdownUserCodeBg,
    markdownUserCodeText,
    markdownUserFenceBg,
    markdownUserFenceText,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    themeMode,
  ]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, "environmentId" | "skills"> & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: TurnId | null;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly onToggleWorkRow: (rowId: string) => void;
    readonly onToggleTurnFold: (turnId: TurnId) => void;
    readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
    readonly onMarkdownLinkPress: (href: string) => void;
    readonly onLoadEarlier: () => void;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly userBubbleMaxWidth: number;
    readonly feedOpenedAt: number;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "load-earlier") {
    return <LoadEarlierRow onLoadEarlier={props.onLoadEarlier} />;
  }

  if (entry.type === "turn-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.turnId)}
        hitSlop={4}
        className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-border px-2"
      >
        <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
          {entry.label}
        </Text>
        <SymbolView
          name={entry.expanded ? "chevron.down" : "chevron.right"}
          size={15}
          tintColor={iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        onlyToolActivities={entry.onlyToolActivities}
        onToggle={() => props.onToggleWorkGroup(entry.groupId)}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = message.text.includes("<review_comment");
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
      const enterAnimated = shouldPlayEntrance(message.createdAt, props.feedOpenedAt);
      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(hasReviewCommentContext ? { width: props.reviewCommentBubbleWidth } : null),
            }}
          >
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={message.text}
                markdownStyles={styles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                onLinkPress={props.onMarkdownLinkPress}
              />
            ) : null}
            {attachments.map((attachment) => {
              return (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  className="aspect-[1.3] w-full rounded-[14px] bg-subtle"
                  onPressImage={props.onPressImage}
                />
              );
            })}
          </View>
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-muted">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </Animated.View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (message.text.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = shouldPlayEntrance(message.createdAt, props.feedOpenedAt);
    return (
      <Animated.View
        className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-2 px-1")}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {message.text.trim().length > 0 ? (
          hasNativeSelectableMarkdownText() ? (
            <SelectableMarkdownText
              markdown={message.text}
              skills={props.skills}
              textStyle={styles.nativeTextStyle}
              onLinkPress={props.onMarkdownLinkPress}
            />
          ) : (
            <Markdown
              options={{ gfm: true }}
              renderers={styles.renderers}
              styles={styles.styles}
              theme={styles.theme}
            >
              {message.text}
            </Markdown>
          )
        ) : null}
        {attachments.map((attachment) => {
          return (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-subtle"
              onPressImage={props.onPressImage}
            />
          );
        })}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={message.text}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-muted">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      activities={entry.activities}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      feedOpenedAt={props.feedOpenedAt}
      iconSubtleColor={iconSubtleColor}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
    />
  );
}

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onLinkPress: (href: string) => void;
}) {
  const segments = parseReviewCommentMessageSegments(props.text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  if (!hasReviewComment) {
    if (hasNativeSelectableMarkdownText()) {
      return (
        <SelectableMarkdownText
          markdown={props.text}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          preserveSoftBreaks
          onLinkPress={props.onLinkPress}
        />
      );
    }
    return (
      <Markdown
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {props.text}
      </Markdown>
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            onLinkPress={props.onLinkPress}
          />
        ) : (
          <Markdown
            key={segment.id}
            options={{ gfm: true }}
            renderers={props.markdownStyles.renderers}
            styles={props.markdownStyles.styles}
            theme={props.markdownStyles.theme}
          >
            {text}
          </Markdown>
        );
      })}
    </View>
  );
}

const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment;
  readonly colors: ReviewCommentColors;
}) {
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const colorScheme = useColorScheme();
  const appearanceScheme = colorScheme === "light" ? "light" : "dark";
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment]);
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme),
    [appearanceScheme],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border border-continuous"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px] border-continuous"
          style={{ backgroundColor: props.colors.mutedBackground }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-xs"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {compactFileName(props.comment.filePath)}
          </Text>
        </View>
      </View>
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono"
            style={{
              color: props.colors.text,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text selectable className="text-base leading-snug" style={{ color: props.colors.text }}>
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (!diff) {
    return "";
  }

  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}

function compactFileName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

// Chrome rows have genuinely fixed heights (content box + margin) that never
// change with content: seeding them via getFixedItemSize avoids the 180px flat
// estimate stretching them ~4x while unmeasured. Only truly immutable rows may
// be seeded — feeding measured heights of mutable rows (messages, activity
// groups) back into getFixedItemSize poisons @legendapp/list's sizesKnown
// ground truth (getKnownOrFixedSize adds scrollAxisGap on top, and native
// isNativeLayoutNoise then drops the real correction), which overlapped rows.
const TURN_FOLD_ROW_HEIGHT = 56;
const WORK_TOGGLE_ROW_HEIGHT = 36;
const LOAD_EARLIER_ROW_HEIGHT = 44;

// Head sentinel of a windowed feed. LegendList only mounts rows within its draw
// distance, so this row mounting means the reader has scrolled to the current
// head — the cue to page in the next window of older history. Firing on mount
// (once per instance) turns scroll-to-top into automatic upward paging; the
// widened window unmounts this instance until the new head is reached, and
// maintainVisibleContentPosition keeps the viewport pinned as content prepends.
const LoadEarlierRow = memo(function LoadEarlierRow(props: { readonly onLoadEarlier: () => void }) {
  const requestedRef = useRef(false);
  useEffect(() => {
    if (requestedRef.current) {
      return;
    }
    requestedRef.current = true;
    props.onLoadEarlier();
  }, [props.onLoadEarlier]);

  return (
    <View style={{ height: LOAD_EARLIER_ROW_HEIGHT }} className="mb-2 items-center justify-center">
      <ActivityIndicator />
    </View>
  );
});

// Gap between the floating jump-to-bottom arrow and the composer/keyboard it
// rests above.
const JUMP_TO_BOTTOM_GAP = 12;
const JUMP_TO_BOTTOM_SIZE = 44;

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const navigation = useNavigation();
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldSettleFrameRef = useRef<number | null>(null);
  const foldSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const previousLatestTurnRef = useRef(props.latestTurn);
  // Tracks the last send anchor so a fresh one can briefly animate the end scroll
  // (smooth glide to the just-sent message) while streaming stays instant.
  const previousAnchorMessageIdRef = useRef<MessageId | null>(props.anchorMessageId);
  const sendAnchorAnimationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When this thread was opened. Rows created before this never replay an
  // entrance animation, so a freshly hydrated history (even one active moments
  // ago) paints without a burst of simultaneous FadeIns. Reset on thread change
  // in case the component is reused rather than remounted.
  const feedOpenedAtRef = useRef({ threadId: props.threadId, at: Date.now() });
  if (feedOpenedAtRef.current.threadId !== props.threadId) {
    feedOpenedAtRef.current = { threadId: props.threadId, at: Date.now() };
  }
  const feedOpenedAt = feedOpenedAtRef.current.at;
  const { width: windowWidth } = useWindowDimensions();
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const [sendAnchorAnimating, setSendAnchorAnimating] = useState(false);
  // Sticky-scroll follow state: true while the feed should track the live stream,
  // false once the reader has deliberately scrolled up. Derived from real scroll
  // geometry in handleScroll because LegendList's own at-end gate keeps reporting
  // "at end" mid-stream (see threadScrollMaintenance). A ref mirrors it so the
  // scroll handler reads the latest value without re-subscribing.
  const [followStream, setFollowStream] = useState(true);
  // Whether the in-flight scroll is user-driven (drag/fling) rather than a
  // programmatic end-pin, send glide, keyboard shift, or remeasure. Only user
  // scrolls may break follow; anything else can only ever re-arm it at the bottom.
  const userInteractingRef = useRef(false);
  // Set while the jump-to-bottom button's animated scrollToEnd is in flight so the
  // momentum handlers don't flag that programmatic glide as a user scroll (which
  // would be read as scrolling away from the bottom at the start of the animation
  // and immediately re-break the follow we just re-armed).
  const jumpToBottomRef = useRef(false);
  // Latches true when the feed grows while the reader is scrolled away, so the
  // jump button can carry a "new activity" dot. Purely derived from props.feed
  // already on hand — no new runtime state is plumbed for it.
  const [hasNewActivityWhileAway, setHasNewActivityWhileAway] = useState(false);
  const feedLengthRef = useRef(props.feed.length);
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [expandedImage, setExpandedImage] = useState<{
    uri: string;
    headers?: Record<string, string>;
  } | null>(null);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, viewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = contentWidth * 0.85;
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + 44;
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  // With automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext);
  const anchorTopInset = usesNativeAutomaticInsets
    ? navigationHeaderHeight || insets.top + 44
    : topContentInset;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const userBubbleColor = useThemeColor("--color-user-bubble");
  const onMarkdownLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const relativePath = resolveWorkspaceRelativeFilePath(
          props.workspaceRoot,
          presentation.path,
        );
        if (relativePath) {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadFile", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: relativePath.split("/").filter((segment) => segment.length > 0),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
        }
        return;
      }

      if (presentation.href) {
        void Linking.openURL(presentation.href);
      }
    },
    [props.environmentId, props.threadId, props.workspaceRoot, navigation],
  );
  const markdownStyles = useMarkdownStyles(onMarkdownLinkPress);
  const reviewCommentColors = useReviewCommentColors();
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Keep row-local interaction props in extraData so disclosures and copy feedback repaint.
  const listAppearanceData = useMemo(
    () => ({
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
      viewportWidth,
    }),
    [
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
      viewportWidth,
    ],
  );
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) => {
      if (headerMaterialVisibleRef.current === visible) {
        return;
      }
      headerMaterialVisibleRef.current = visible;
      props.onHeaderMaterialVisibilityChange?.(visible);
    },
    [props.onHeaderMaterialVisibilityChange],
  );
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      const distanceFromEnd = distanceFromEndForScrollEvent(event.nativeEvent);
      setFollowStream((current) =>
        nextFollowStream(current, {
          distanceFromEnd,
          isUserScroll: userInteractingRef.current,
        }),
      );
    },
    [reportHeaderMaterialVisibility, anchorTopInset],
  );
  const handleScrollBeginDrag = useCallback(() => {
    // A real touch always cancels any in-flight jump glide and counts as a user
    // scroll from here on.
    jumpToBottomRef.current = false;
    userInteractingRef.current = true;
  }, []);
  const handleMomentumScrollEnd = useCallback(() => {
    userInteractingRef.current = false;
    jumpToBottomRef.current = false;
  }, []);
  // A drag with no fling never emits momentum events; clear the flag on drag end
  // (a fling re-sets it via onMomentumScrollBegin before this frame matters).
  const handleScrollEndDrag = useCallback(() => {
    userInteractingRef.current = false;
  }, []);
  const handleMomentumScrollBegin = useCallback(() => {
    // A programmatic scrollToEnd can surface momentum events on some platforms;
    // don't let the jump glide masquerade as a user scroll.
    if (jumpToBottomRef.current) {
      return;
    }
    userInteractingRef.current = true;
  }, []);
  const handleJumpToBottom = useCallback(() => {
    void Haptics.selectionAsync();
    // Programmatic glide: keep the momentum/scroll handlers from reading it as a
    // user scroll, and re-arm follow up front so streamed frames re-pin to the end.
    jumpToBottomRef.current = true;
    userInteractingRef.current = false;
    setFollowStream(true);
    setHasNewActivityWhileAway(false);
    void props.listRef.current?.scrollToEnd({ animated: true }).catch(() => {
      jumpToBottomRef.current = false;
    });
  }, [props.listRef]);
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  // Only genuinely fixed-height chrome rows may be seeded. Mutable rows
  // (messages, activity groups) return undefined so LegendList measures them
  // and learns per-type averages from getItemType — never a persisted per-row
  // size, which poisoned the library's measurement ground truth and overlapped
  // rows on native.
  const getFixedItemSize = useCallback((entry: ThreadFeedEntry) => {
    if (entry.type === "turn-fold") {
      return TURN_FOLD_ROW_HEIGHT;
    }
    if (entry.type === "work-toggle") {
      return WORK_TOGGLE_ROW_HEIGHT;
    }
    if (entry.type === "load-earlier") {
      return LOAD_EARLIER_ROW_HEIGHT;
    }
    return undefined;
  }, []);

  const pullRefresh = useEnvironmentPullRefresh(
    useMemo(() => [props.environmentId], [props.environmentId]),
  );

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
    // A freshly opened thread starts pinned to the newest message; drop any
    // scrolled-up follow state carried over from the previous thread.
    setFollowStream(true);
    setHasNewActivityWhileAway(false);
    userInteractingRef.current = false;
    jumpToBottomRef.current = false;
    // Re-baseline the feed-length watermark to the new thread's feed so the
    // first post-switch growth doesn't spuriously latch new-activity. Read, not
    // depended on: this effect only re-runs on a thread switch.
    feedLengthRef.current = props.feed.length;
  }, [props.threadId, reportHeaderMaterialVisibility]);

  // Track feed growth so the jump button can flag unseen activity. Latch on when
  // new entries arrive while the reader is away; clear the instant follow resumes.
  useEffect(() => {
    const previousLength = feedLengthRef.current;
    feedLengthRef.current = props.feed.length;
    setHasNewActivityWhileAway((current) =>
      nextNewActivityWhileAway({
        current,
        followingStream: followStream,
        feedGrew: props.feed.length > previousLength,
      }),
    );
  }, [props.feed.length, followStream]);

  const expandedWorkGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [groupId, expanded] of Object.entries(expandedWorkGroups)) {
      if (expanded) {
        ids.add(groupId);
      }
    }
    return ids;
  }, [expandedWorkGroups]);
  const presentedFeed = useMemo(
    () =>
      deriveThreadFeedPresentation(
        props.feed,
        props.latestTurn,
        expandedTurnIds,
        expandedWorkGroupIds,
      ),
    [expandedTurnIds, expandedWorkGroupIds, props.feed, props.latestTurn],
  );

  // The empty↔filled key below remounts the list, which resets its imperative
  // content-inset override — and useKeyboardChatComposerInset (mounted above
  // the remount boundary) deduplicates by height, so it never re-reports the
  // composer inset to the fresh instance. Without this, the remounted list's
  // initial scroll-to-end computes with a zero end inset and rests one
  // composer-height short of the end. Layout effect: it must land before the
  // list's first positioning tick or the one-shot initial scroll misses it.
  const listMountKey = `${props.threadId}:${props.feed.length === 0 ? "empty" : "filled"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef]);

  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(
        presentedFeed,
        props.anchorMessageId,
        (entry) => (entry.type === "message" ? entry.id : null),
        { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
      ),
    [presentedFeed, props.anchorMessageId, anchorTopInset],
  );
  const terminalAssistantMessageIds = useMemo(() => {
    const terminalIdsByTurn = new Map<TurnId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  }, [props.feed]);
  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === "running")
      ? props.latestTurn.turnId
      : null;

  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestTurn;
    if (!props.latestTurn || !previous) {
      return;
    }
    if (props.latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && props.latestTurn.state === "interrupted") {
        const interruptedTurnId = props.latestTurn.turnId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.turnId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.turnId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestTurn]);

  // A just-sent message (new send anchor) glides to its anchor: animate the end
  // scroll for a short beat, then fall back to instant. Instant is what keeps a
  // live stream from oscillating — an animated scrollToEnd re-fired on every
  // streamed dataChange fights maintainVisibleContentPosition's restore, yanking
  // the feed up and down (the library only reconciles the two on web).
  useEffect(() => {
    const previous = previousAnchorMessageIdRef.current;
    previousAnchorMessageIdRef.current = props.anchorMessageId;
    if (!shouldArmSendAnchorAnimation(previous, props.anchorMessageId)) {
      return;
    }
    // Sending your own message always re-arms follow: the feed glides to the new
    // anchor and tracks the reply, even if you had scrolled up before sending.
    setFollowStream(true);
    setSendAnchorAnimating(true);
    if (sendAnchorAnimationTimeoutRef.current) {
      clearTimeout(sendAnchorAnimationTimeoutRef.current);
    }
    sendAnchorAnimationTimeoutRef.current = setTimeout(() => {
      setSendAnchorAnimating(false);
      sendAnchorAnimationTimeoutRef.current = null;
    }, SEND_ANCHOR_ANIMATION_WINDOW_MS);
  }, [props.anchorMessageId]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (sendAnchorAnimationTimeoutRef.current) {
        clearTimeout(sendAnchorAnimationTimeoutRef.current);
      }
      if (foldSettleFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleFrameRef.current);
      }
      if (foldSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string | null) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (foldSettleFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleFrameRef.current);
    }
    if (foldSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleSecondFrameRef.current);
    }
    foldSettleFrameRef.current = requestAnimationFrame(() => {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        foldSettleFrameRef.current = null;
        foldSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const maintainScrollAtEnd = useMemo(
    () =>
      resolveEndScrollMaintenance({
        followingStream: followStream,
        disclosureToggleSettling,
        sendAnchorAnimating,
      }),
    [followStream, disclosureToggleSettling, sendAnchorAnimating],
  );

  const jumpToBottomState = deriveJumpToBottomState({
    followingStream: followStream,
    hasNewActivityWhileAway,
  });
  const isDarkMode = useColorScheme() === "dark";
  const jumpSurfaceColor = useThemeColor("--color-menu-surface");
  const jumpBorderColor = useThemeColor("--color-border");
  const jumpIconColor = useThemeColor("--color-icon");
  const jumpShadowColor = useThemeColor("--color-drawer-shadow");
  const jumpAccentColor = useThemeColor("--color-primary");
  // On iOS the keyboard composer inset is reported net of the safe-area bottom
  // (UIKit adds it back). Fold it back in here so the arrow rests above the whole
  // visual composer rather than sinking a home-indicator's worth into it.
  const jumpBottomInsetCompensation = usesNativeAutomaticInsets ? insets.bottom : 0;
  const jumpButtonPositionStyle = useAnimatedStyle(() => ({
    bottom:
      props.contentInsetEndAdjustment.value + jumpBottomInsetCompensation + JUMP_TO_BOTTOM_GAP,
  }));

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string) => {
      suspendEndScrollMaintenanceForDisclosure(`work-toggle:${groupId}`);
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string) => {
      suspendEndScrollMaintenanceForDisclosure(rowId);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return { ...current, expandedTurnIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onPressImage = useCallback((uri: string, headers?: Record<string, string>) => {
    setExpandedImage({ uri, headers });
  }, []);

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) =>
      renderFeedEntry(info, {
        environmentId: props.environmentId,
        copiedRowId,
        expandedWorkRows,
        terminalAssistantMessageIds,
        unsettledTurnId,
        onCopyWorkRow,
        onToggleWorkGroup,
        onToggleWorkRow,
        onToggleTurnFold,
        onPressImage,
        onMarkdownLinkPress,
        iconSubtleColor,
        userBubbleColor,
        markdownStyles,
        reviewCommentColors,
        reviewCommentBubbleWidth,
        userBubbleMaxWidth,
        feedOpenedAt,
        onLoadEarlier: props.onLoadEarlier,
        skills: props.skills,
      }),
    [
      copiedRowId,
      expandedWorkRows,
      terminalAssistantMessageIds,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      userBubbleMaxWidth,
      feedOpenedAt,
      onCopyWorkRow,
      onMarkdownLinkPress,
      onPressImage,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.environmentId,
      props.onLoadEarlier,
      props.skills,
    ],
  );

  if (props.contentPresentation.kind === "unavailable") {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  return (
    <>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          <KeyboardAwareLegendList
            ref={props.listRef}
            // The empty↔filled key remounts the list when messages first
            // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
            // which is blind to UIKit's adjustedContentInset — inserting into
            // an already-attached list under a transparent header can pin
            // short content at offset 0 (one header-height too high). A fresh
            // mount positions during attach, where UIKit applies the inset.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area
            // (facebook/react-native#54123); the anchored end space after a send
            // is pure inset, so without this the blank region can't be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? "automatic" : "never"}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // Do NOT pass a manual `contentInset` here. Like the Home
                  // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                  // "automatic"` so UIKit derives the top inset from the transparent
                  // header. A manual contentInset (which LegendList consumes into its
                  // own layout math) collapses the scroll view's adjustedContentInset
                  // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                  // render into — which is why the header blur was missing on threads.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            itemLayoutAnimation={FEED_ITEM_LAYOUT_TRANSITION}
            // Patched LegendList prop (patches/@legendapp__list@3.2.0.patch):
            // lets its scroll math clamp programmatic scrolls to -headerInset
            // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
            // content rest below the transparent header rather than at frame top.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            // UIKit's automatic behavior adds the safe-area bottom on top of the
            // raw contentInset the keyboard integration writes. The detail screen
            // under-reports the composer inset by this amount (see
            // ThreadDetailScreen); this tells LegendList's scroll math about the
            // extra so programmatic end scrolls land at the true resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // The keyboard integration's offset math (end pinning, max scroll)
            // must add the same UIKit-added extra, or its keyboard-open end
            // targets land one safe-area short of the true resting offset.
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // Animated end pinning is scoped to the post-send window only (see
            // threadScrollMaintenance): on send, the optimistic message's
            // dataChange fires maintainScrollAtEnd before the explicit anchor
            // scroll runs, and an instant snap teleports the feed to the anchor
            // instead of gliding to it. During streaming it stays instant —
            // an animated scrollToEnd re-fired on every streamed dataChange
            // fights maintainVisibleContentPosition's restore (uncoordinated on
            // native; the library only reconciles the two on web) and yanks the
            // feed up and down on a loop.
            maintainScrollAtEnd={maintainScrollAtEnd}
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) =>
              entry.type === "message" ? `message:${entry.message.role}` : entry.type
            }
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            // Seed the list's scroll math with the real viewport before its own
            // onLayout: the empty→filled remount can then tell at mount that
            // short content underflows the viewport and skip programmatic
            // positioning entirely (any offset write during screen attach races
            // UIKit's adjustedContentInset application and lands high or low).
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // RN's native scrollTo command clamps targets to a floor of
            // -contentInset.top using the RAW inset — under automatic insets the
            // header inset only exists in adjustedContentInset, so scrolls to
            // negative offsets (content top below the transparent header) get
            // clamped to 0. This prop disables that clamp; UIKit still bounces
            // user overscroll back to the adjusted rest position.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            getFixedItemSize={getFixedItemSize}
            initialScrollAtEnd
            onRefresh={() => void pullRefresh.onRefresh()}
            refreshing={pullRefresh.isRefreshing}
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            ListHeaderComponent={
              usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />
            }
            contentContainerStyle={{
              paddingTop: 12,
              paddingHorizontal: contentHorizontalPadding,
            }}
          />
        </View>
        {props.feed.length === 0 && props.contentPresentation.kind === "ready" ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ThreadFeedPlaceholder
              title="No conversation yet"
              detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
        {/* Floating "jump to latest" arrow. Rides the same KeyboardStickyView
            mechanism as the composer so it stays a fixed gap above it and lifts
            with the keyboard; box-none lets every other touch reach the list.
            Only shown once the reader has scrolled away (followStream === false). */}
        <KeyboardStickyView
          style={StyleSheet.absoluteFill}
          offset={{ closed: 0, opened: 0 }}
          pointerEvents="box-none"
        >
          {jumpToBottomState.visible ? (
            <Animated.View
              pointerEvents="box-none"
              entering={ZoomIn.duration(180)}
              exiting={ZoomOut.duration(140)}
              style={[
                {
                  position: "absolute",
                  right: horizontalPadding,
                },
                jumpButtonPositionStyle,
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Scroll to latest"
                hitSlop={8}
                onPress={handleJumpToBottom}
                style={({ pressed }) => ({
                  width: JUMP_TO_BOTTOM_SIZE,
                  height: JUMP_TO_BOTTOM_SIZE,
                  borderRadius: JUMP_TO_BOTTOM_SIZE / 2,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: jumpSurfaceColor,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: jumpBorderColor,
                  // M3 level-2/3 floating chrome: tonal surface + restrained
                  // elevation on Android, a soft ambient shadow on iOS.
                  shadowColor: jumpShadowColor,
                  shadowOpacity: isDarkMode ? 0.35 : 0.14,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 3,
                  opacity: pressed ? 0.85 : 1,
                  transform: [{ scale: pressed ? 0.96 : 1 }],
                })}
              >
                <SymbolView
                  name={{ ios: "chevron.down", android: "arrow_downward" }}
                  size={20}
                  tintColor={jumpIconColor}
                  type="monochrome"
                />
                {jumpToBottomState.showNewActivityDot ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: jumpAccentColor,
                      borderWidth: 2,
                      borderColor: jumpSurfaceColor,
                    }}
                  />
                ) : null}
              </Pressable>
            </Animated.View>
          ) : null}
        </KeyboardStickyView>
      </View>

      <ImageViewing
        images={
          expandedImage
            ? [
                {
                  uri: expandedImage.uri,
                  headers: expandedImage.headers,
                },
              ]
            : []
        }
        imageIndex={0}
        visible={expandedImage !== null}
        onRequestClose={() => setExpandedImage(null)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </>
  );
});
