import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownImage } from "./markdown-image.js";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  ambientRead: vi.fn(),
  sourceRead: vi.fn(),
  resolveServices: vi.fn(),
  initialPreview: null as unknown,
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (callback: () => unknown) => callback(),
  useEffect: (callback: () => unknown) => mocks.effects.push(callback),
  useState: (initial: unknown) => [
    mocks.stateIndex++ === 0 ? mocks.initialPreview : initial,
    vi.fn(),
  ],
  useRef: (initial: unknown) => ({ current: initial }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ fileService: { readMediaPreview: mocks.ambientRead } }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: mocks.resolveServices,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("./image-preview-dialog.js", () => ({
  ImagePreviewDialog: () => null,
  sanitizeImageSourceForLog: (value: string) => value,
}));

describe("Markdown image frozen source Host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effects.length = 0;
    mocks.initialPreview = null;
    mocks.stateIndex = 0;
    mocks.ambientRead.mockResolvedValue({ mediaType: "image/png", dataBase64: "ambient" });
    mocks.sourceRead.mockResolvedValue({ mediaType: "image/png", dataBase64: "source" });
    mocks.resolveServices.mockReturnValue({ fileService: { readMediaPreview: mocks.sourceRead } });
  });

  it("hides the previous Host image before the source-changing effect runs", () => {
    mocks.initialPreview = {
      services: { fileService: { readMediaPreview: mocks.ambientRead } },
      path: "/repo/docs/chart.png",
      dataUrl: "data:image/png;base64,OLD_HOST",
      failed: false,
    };
    let element = MarkdownImage({
      src: "./chart.png",
      workspacePath: "/repo/docs",
      workspaceRootPath: "/repo",
      workspaceIdentity: "remote-B:/repo",
      workspaceRemoteSessionId: "B",
    }) as ReactElement;
    while (typeof element.type === "function") {
      element = (element.type as (props: unknown) => ReactElement)(element.props);
    }
    expect((element.props as Record<string, unknown>)["data-markdown-local-image"]).toBe("loading");
    expect(mocks.sourceRead).not.toHaveBeenCalled();
  });

  it("reads the source Host rather than the active pane Host", async () => {
    const props = {
      src: "./chart.png",
      workspacePath: "/repo/docs",
      workspaceRootPath: "/repo",
      workspaceIdentity: "remote-B:/repo",
      workspaceRemoteSessionId: "B",
    };
    let element = MarkdownImage(props) as ReactElement;
    while (typeof element.type === "function") {
      element = (element.type as (props: unknown) => ReactElement)(element.props);
    }
    for (const effect of mocks.effects) effect();
    await Promise.resolve();

    expect(mocks.sourceRead).toHaveBeenCalledWith({ path: "/repo/docs/chart.png" });
    expect(mocks.ambientRead).not.toHaveBeenCalled();
    expect(mocks.resolveServices).toHaveBeenCalledWith(
      "/repo",
      "B",
      "remote-B:/repo",
      undefined,
      "exact",
    );
  });

  it("keeps unfrozen legacy images on their ambient service", async () => {
    let element = MarkdownImage({
      src: "./chart.png",
      workspacePath: "/repo/docs",
    }) as ReactElement;
    while (typeof element.type === "function") {
      element = (element.type as (props: unknown) => ReactElement)(element.props);
    }
    for (const effect of mocks.effects) effect();
    await Promise.resolve();
    expect(mocks.ambientRead).toHaveBeenCalledWith({ path: "/repo/docs/chart.png" });
    expect(mocks.sourceRead).not.toHaveBeenCalled();
    expect(mocks.resolveServices).not.toHaveBeenCalled();
  });
});
