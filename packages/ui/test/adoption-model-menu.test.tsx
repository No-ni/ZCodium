import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigSelect } from "../src/ModelConfigSelect.js";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";
import type { ModelSelectionView } from "@zcode/services";

const capture = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  contents: [] as Record<string, unknown>[],
  tooltips: [] as Record<string, unknown>[],
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, ...props }: { children?: ReactNode }) => {
    capture.tooltips.push(props);
    return children;
  },
}));
vi.mock("@/chat-input-toolbar/RollingToolbarLabel.js", () => ({
  RollingToolbarLabel: ({ label }: { label: string }) => createElement("span", null, label),
}));
vi.mock("@/components/ModelInputCapabilityBadge.js", () => ({
  ModelInputCapabilityBadge: () => createElement("span", { "aria-label": "Vision" }),
}));
vi.mock("@/components/ui/scroll-fade-viewport.js", () => ({
  ScrollFadeViewport: ({ children, className, ...props }: ComponentProps<"div">) =>
    createElement("div", { ...props, className }, children),
}));
vi.mock("@/components/ui/dropdown-menu.js", () => {
  const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const item = ({ children, ...props }: { children?: ReactNode }) => {
    capture.items.push(props);
    return createElement("div", { "data-testid": props["data-testid"] }, children);
  };
  return {
    DropdownMenu: wrapper,
    DropdownMenuPortal: wrapper,
    DropdownMenuTrigger: wrapper,
    DropdownMenuSub: wrapper,
    DropdownMenuRadioGroup: wrapper,
    DropdownMenuLabel: wrapper,
    DropdownMenuSeparator: () => createElement("hr"),
    DropdownMenuItem: item,
    DropdownMenuRadioItem: item,
    DropdownMenuSubTrigger: item,
    DropdownMenuSubContent: wrapper,
    DropdownMenuContent: ({ children, ...props }: { children?: ReactNode }) => {
      capture.contents.push(props);
      return createElement("div", { role: "menu", className: props.className }, children);
    },
  };
});
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

const groups = [
  {
    key: "provider-a",
    label: "Provider A",
    items: [
      { key: "a", value: "provider-a/model-a", name: "Model A", supportsVisionInput: true },
      { key: "b", value: "provider-a/model-b", name: "Model B" },
    ],
  },
  {
    key: "provider-b",
    label: "Provider B",
    items: [{ key: "fixed", value: "provider-b/fixed", name: "Fixed model" }],
  },
];
const levels = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
  { value: "high", label: "High" },
];
const noop = () => {};
function props(overrides: Record<string, unknown> = {}) {
  return {
    modelGroups: groups,
    normalizedValue: "provider-a/model-a",
    triggerLabel: "Model A",
    tooltipTitle: "Model A",
    showManageModelsAction: true,
    manageModelsLabel: "Manage models",
    onManageModels: noop,
    lockReasonMessage: "Locked",
    isItemLocked: () => false,
    onValueChange: noop,
    open: true,
    onOpenChange: noop,
    focusSelectorOnClose: null,
    composerOptions: {
      providerLabel: "Select provider",
      modelsLabel: "Models",
      effortLabel: "Reasoning effort",
      effortShortcutLabel: "Alt+R",
      selectModelLabel: "Choose model",
      levels,
      value: "high",
      onValueChange: noop,
    },
    ...overrides,
  };
}
function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(ModelConfigSelect, props(overrides) as ComponentProps<typeof ModelConfigSelect>),
  );
}
function selectModelItem(value: string) {
  const entry = capture.items.find(
    (item) => item["data-testid"] === `chat-model-select-item-${value}`,
  );
  expect(entry).toBeDefined();
  return entry as { onSelect(event: { preventDefault(): void }): void };
}

beforeEach(() => {
  capture.items.length = 0;
  capture.contents.length = 0;
  capture.tooltips.length = 0;
});

describe("adoption combined model menu", () => {
  it("shows a single combined trigger with the bound effort and a discrete slider", () => {
    const markup = render();
    expect(markup).toContain('data-composer-combined-model="true"');
    expect(markup).toContain('aria-label="Model A High"');
    expect(markup).toContain('data-testid="composer-thought-slider"');
    expect(markup).toContain('aria-valuetext="High"');
    expect(markup).toContain('max="2"');
    expect(markup).toContain("Alt+R");
    expect(markup).not.toContain('role="switch"');
  });

  it("keeps the combined menu open after selecting another or the current model", () => {
    for (const value of ["provider-a/model-a", "provider-a/model-b"]) {
      capture.items.length = 0;
      const changed = vi.fn();
      const close = vi.fn();
      render({ onValueChange: changed, onOpenChange: close });
      const preventDefault = vi.fn();
      selectModelItem(value).onSelect({ preventDefault });
      expect(changed).toHaveBeenCalledExactlyOnceWith(value);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    }
  });

  it("retains legacy non-composer selection and closes that menu", () => {
    const changed = vi.fn();
    const close = vi.fn();
    const markup = render({
      composerOptions: undefined,
      onValueChange: changed,
      onOpenChange: close,
    });
    selectModelItem("provider-a/model-b").onSelect({ preventDefault: vi.fn() });
    expect(changed).toHaveBeenCalledExactlyOnceWith("provider-a/model-b");
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
    expect(markup).not.toContain("composer-thought-slider");
  });

  it("does not manufacture an effort value for an unbound or invalid selection", () => {
    const options = props().composerOptions;
    const empty = render({
      normalizedValue: "",
      triggerLabel: "Choose model",
      composerOptions: { ...options, value: "" },
    });
    expect(empty).toContain('aria-label="Choose model"');
    expect(empty).not.toContain("data-composer-thought-label");
    expect(empty).not.toContain("composer-thought-meter");
    capture.items.length = 0;
    const invalid = render({ composerOptions: { ...options, value: "missing" } });
    expect(invalid).toContain('aria-valuetext="—"');
    expect(invalid).toContain('data-progress="0"');
  });

  it("renders fixed effort read-only and omits an absent capability", () => {
    const options = props().composerOptions;
    const fixed = render({
      composerOptions: { ...options, levels: [{ value: "off", label: "Off" }], value: "off" },
    });
    expect(fixed).toContain('data-testid="composer-thought-value"');
    expect(fixed).toContain("Off");
    expect(fixed).not.toContain("composer-thought-slider");
    expect(fixed).not.toContain("Alt+R");
    const absent = render({ composerOptions: { ...options, levels: [], value: "" } });
    expect(absent).not.toContain("composer-thought-slider");
    expect(absent).not.toContain("composer-thought-value");
  });

  it("keeps a disabled catalog-pending slider mounted instead of a focus-losing input", () => {
    const options = props().composerOptions;
    const markup = render({ composerOptions: { ...options, pending: true } });
    expect(markup).toContain('data-testid="composer-thought-slider"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toMatch(/<input[^>]* disabled/);
  });

  it("does not render the directory while closed and disables passive tooltip while open", () => {
    render({ open: false });
    expect(capture.items).toHaveLength(0);
    expect(capture.contents).toHaveLength(0);
    render();
    expect(capture.tooltips.at(-1)?.open).toBe(false);
  });

  it("retains model management for an empty directory and constrains the overlay", () => {
    const markup = render({ modelGroups: [], normalizedValue: "" });
    expect(markup).toContain("Manage models");
    expect(capture.contents.at(-1)?.className).toContain("min-w-0");
    expect(capture.contents.at(-1)?.className).toContain("overflow-y-hidden");
    expect(capture.contents.at(-1)?.collisionPadding).toBe(12);
  });
});

describe("one model and effort per frozen submission", () => {
  const view = {
    revision: 1,
    providers: [
      {
        providerId: "provider-a",
        models: [
          {
            modelId: "model-a",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
          {
            modelId: "model-b",
            config: { optionSpecs: { reasoningLevel: { values: ["off", "medium", "high"] } } },
          },
        ],
      },
    ],
  } as unknown as ModelSelectionView;
  it("freezes B/medium and never inherits A's level or later draft changes", () => {
    const draft = {
      mode: "build",
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-b",
        options: { reasoningLevel: "medium" },
      },
    };
    const frozen = createComposerSubmissionConfig(draft, view);
    expect(frozen?.modelSelection).toEqual(draft.modelSelection);
    expect(Object.isFrozen(frozen?.modelSelection.options)).toBe(true);
    draft.modelSelection.modelId = "model-a";
    draft.modelSelection.options.reasoningLevel = "low";
    expect(frozen?.modelSelection).toEqual({
      providerId: "provider-a",
      modelId: "model-b",
      options: { reasoningLevel: "medium" },
    });
  });
  it("does not submit missing, cross-model or unavailable options", () => {
    for (const selection of [
      { providerId: "provider-a", modelId: "model-a" },
      { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "medium" } },
      { providerId: "provider-a", modelId: "missing", options: { reasoningLevel: "high" } },
    ])
      expect(
        createComposerSubmissionConfig({ mode: "build", modelSelection: selection }, view),
      ).toBeNull();
    expect(
      createComposerSubmissionConfig(
        {
          mode: "build",
          modelSelection: {
            providerId: "provider-a",
            modelId: "model-a",
            options: { reasoningLevel: "high" },
          },
        },
        null,
      ),
    ).toBeNull();
  });
});
