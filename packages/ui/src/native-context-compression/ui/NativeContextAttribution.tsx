import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 原因：产品新增外链归本仓；署名章节保留许可要求的上游出处链接。
const DOCUMENTATION =
  "https://github.com/No-ni/ZCodium/blob/main/docs/specs/native-context-compression.md";
const SOURCES = [
  ["kernel", "acp-kernel", DOCUMENTATION + "#acp-kernel"],
  ["project", "billion-context", DOCUMENTATION + "#billion-context"],
] as const;

export function NativeContextAttribution() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const linkClass =
    "inline-flex min-h-11 items-center text-ui-xs text-foreground-subtle underline underline-offset-2 hover:text-foreground focus-visible:rounded focus-visible:outline-2 focus-visible:outline-ring";
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 text-ui-xs text-foreground-subtle"
      data-testid="native-context-attribution"
    >
      <a
        href={DOCUMENTATION}
        className={linkClass}
        data-testid="native-context-feature-documentation"
        onClick={(event) => {
          event.preventDefault();
          platform.openExternal(DOCUMENTATION);
        }}
      >
        {intl.formatMessage({ id: "nativeContext.featureDocumentation" })}
      </a>
      <span>{intl.formatMessage({ id: "nativeContext.kernelAttribution" })}</span>
      {SOURCES.map(([key, name, url]) => (
        <a
          key={key}
          href={url}
          className={linkClass}
          data-testid={"native-context-attribution-" + key}
          onClick={(event) => {
            event.preventDefault();
            platform.openExternal(url);
          }}
        >
          {name}
        </a>
      ))}
    </div>
  );
}
