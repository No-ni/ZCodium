import { describe, expect, it, vi } from "vitest";
import { observeCodeSnippetVisibility } from "../src/components/ui/codeSnippetVisibility.js";

type MockEntry = Pick<IntersectionObserverEntry, "target" | "isIntersecting">;

class MockIntersectionObserver {
  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];
  disconnectCalls = 0;

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve(target: Element) {
    this.unobserved.push(target);
  }

  disconnect() {
    this.disconnectCalls += 1;
  }

  emit(entries: readonly MockEntry[]) {
    this.callback(
      entries.map((entry) => entry as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

function createDocumentWithObserver() {
  const observers: MockIntersectionObserver[] = [];
  class TestIntersectionObserver extends MockIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      super(callback);
      observers.push(this);
    }
  }

  const document = {
    defaultView: { IntersectionObserver: TestIntersectionObserver },
  } as unknown as Document;

  return { document, observers };
}

function createElement(ownerDocument: Document): Element {
  return { ownerDocument } as Element;
}

describe("code snippet visibility subscriptions", () => {
  it("shares one observer for 240 elements in a document and dispatches only matching targets", () => {
    const { document, observers } = createDocumentWithObserver();
    const elements = Array.from({ length: 240 }, () => createElement(document));
    const listeners = elements.map(() => vi.fn((_visible: boolean) => undefined));
    const cleanups = elements.map((element, index) =>
      observeCodeSnippetVisibility(element, listeners[index]!),
    );

    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toHaveLength(240);

    const visibleIndex = 173;
    const hiddenIndex = 12;
    observers[0]!.emit([
      { target: elements[visibleIndex]!, isIntersecting: true },
      { target: elements[hiddenIndex]!, isIntersecting: false },
      { target: createElement(document), isIntersecting: true },
    ]);

    expect(listeners[visibleIndex]).toHaveBeenCalledTimes(1);
    expect(listeners[visibleIndex]).toHaveBeenCalledWith(true);
    expect(listeners[hiddenIndex]).toHaveBeenCalledTimes(1);
    expect(listeners[hiddenIndex]).toHaveBeenCalledWith(false);
    for (const [index, listener] of listeners.entries()) {
      if (index !== visibleIndex && index !== hiddenIndex) {
        expect(listener).not.toHaveBeenCalled();
      }
    }

    cleanups.forEach((cleanup) => cleanup());
  });

  it("ignores a late entry after its element is cancelled", () => {
    const { document, observers } = createDocumentWithObserver();
    const element = createElement(document);
    const listener = vi.fn((_visible: boolean) => undefined);
    const cleanup = observeCodeSnippetVisibility(element, listener);
    const observer = observers[0]!;

    cleanup();
    observer.emit([{ target: element, isIntersecting: true }]);

    expect(observer.unobserved).toEqual([element]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("disconnects only when the last subscriber leaves", () => {
    const { document, observers } = createDocumentWithObserver();
    const first = createElement(document);
    const second = createElement(document);
    const cleanupFirst = observeCodeSnippetVisibility(first, vi.fn());
    const cleanupSecond = observeCodeSnippetVisibility(second, vi.fn());
    const observer = observers[0]!;

    cleanupFirst();
    expect(observer.disconnectCalls).toBe(0);

    cleanupSecond();
    expect(observer.disconnectCalls).toBe(1);
  });

  it("keeps observer scopes isolated across documents", () => {
    const firstScope = createDocumentWithObserver();
    const secondScope = createDocumentWithObserver();
    const firstElement = createElement(firstScope.document);
    const secondElement = createElement(secondScope.document);
    const firstListener = vi.fn((_visible: boolean) => undefined);
    const secondListener = vi.fn((_visible: boolean) => undefined);
    const cleanupFirst = observeCodeSnippetVisibility(firstElement, firstListener);
    const cleanupSecond = observeCodeSnippetVisibility(secondElement, secondListener);

    expect(firstScope.observers).toHaveLength(1);
    expect(secondScope.observers).toHaveLength(1);
    expect(firstScope.observers[0]).not.toBe(secondScope.observers[0]);

    firstScope.observers[0]!.emit([{ target: secondElement, isIntersecting: true }]);
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).not.toHaveBeenCalled();

    secondScope.observers[0]!.emit([{ target: secondElement, isIntersecting: true }]);
    expect(secondListener).toHaveBeenCalledWith(true);
    expect(firstListener).not.toHaveBeenCalled();

    cleanupFirst();
    cleanupSecond();
  });

  it("leaves plain-text fallback untouched when IntersectionObserver is unavailable", () => {
    const document = { defaultView: null } as unknown as Document;
    const listener = vi.fn((_visible: boolean) => undefined);
    const cleanup = observeCodeSnippetVisibility(createElement(document), listener);

    cleanup();

    expect(listener).not.toHaveBeenCalled();
  });
});
