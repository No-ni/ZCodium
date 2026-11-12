import type {
  NativeContextResolvedToolProtection,
  NativeContextToolProtectionItem,
} from "@zcode/shared/native-context-compression";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const RULES = [
  "protected",
  "latest",
  "earlyFold",
  "preserveRecent",
  "referenceExcluded",
  "distillExcluded",
] as const satisfies readonly (keyof NativeContextToolProtectionItem)[];

export function NativeContextToolProtection({
  protection,
}: {
  protection?: NativeContextResolvedToolProtection;
}) {
  const { intl } = useZCodeIntl();
  return (
    <details
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface"
      data-testid="native-context-tool-protection"
      data-count={protection?.items.length ?? ""}
      data-total={protection?.total ?? ""}
    >
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-ui-base font-medium">
        {intl.formatMessage({ id: "nativeContext.toolProtection" })}
        {protection ? (
          <span className="font-normal text-foreground-subtle">
            {intl.formatMessage(
              { id: "nativeContext.toolProtectionCount" },
              { count: protection.total },
            )}
          </span>
        ) : null}
      </summary>
      <p className="px-3 pb-3 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "nativeContext.toolProtectionHelp" })}
      </p>
      {!protection || protection.total === 0 ? (
        <p className="px-3 pb-3 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: !protection
              ? "nativeContext.toolProtectionUnavailable"
              : "nativeContext.toolProtectionEmpty",
          })}
        </p>
      ) : (
        <table className="w-full table-fixed text-ui-sm">
          <caption className="sr-only">
            {intl.formatMessage({ id: "nativeContext.toolProtection" })}
          </caption>
          <thead className="hidden md:table-header-group">
            <tr className="border-t border-border bg-card">
              <th scope="col" className="w-1/3 px-3 py-3 text-left font-medium">
                {intl.formatMessage({ id: "nativeContext.toolProtectionName" })}
              </th>
              {RULES.map((rule) => (
                <th
                  key={rule}
                  scope="col"
                  className="break-words px-1 py-3 text-center font-medium"
                >
                  {intl.formatMessage({ id: "nativeContext.toolProtectionRule." + rule })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="block divide-y divide-border md:table-row-group">
            {protection.items.map((item) => (
              <tr
                key={item.name}
                className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 md:table-row md:p-0"
                data-tool-name={item.name}
              >
                <th
                  scope="row"
                  className="col-span-2 min-w-0 break-all text-left font-mono font-normal md:table-cell md:px-3 md:py-3"
                >
                  {item.name}
                </th>
                {RULES.map((rule) => (
                  <td
                    key={rule}
                    className="flex min-w-0 items-start justify-between gap-2 md:table-cell md:px-1 md:py-3 md:text-center"
                    data-rule={rule}
                    data-active={item[rule]}
                  >
                    <span className="min-w-0 break-words text-foreground-subtle md:hidden">
                      {intl.formatMessage({ id: "nativeContext.toolProtectionRule." + rule })}
                    </span>
                    <span
                      className={
                        item[rule] ? "shrink-0 text-foreground" : "shrink-0 text-foreground-subtle"
                      }
                    >
                      {intl.formatMessage({
                        id: item[rule] ? "nativeContext.enabled" : "nativeContext.disabled",
                      })}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {protection && protection.total > protection.items.length ? (
        <p
          className="border-t border-border px-3 py-3 text-ui-sm text-foreground-subtle"
          data-testid="native-context-tool-protection-truncated"
        >
          {intl.formatMessage(
            { id: "nativeContext.toolProtectionTruncated" },
            { shown: protection.items.length, total: protection.total },
          )}
        </p>
      ) : null}
    </details>
  );
}
