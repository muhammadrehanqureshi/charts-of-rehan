// @vitest-environment jsdom
/**
 * The dialog's focus contract.
 *
 * The parent re-renders on every keystroke and hands the dialog a fresh
 * onClose function. Focusing on that dependency used to send the caret to the
 * header close button after each letter, which made naming a custom indicator
 * impossible.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dialog } from "./SettingsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("Dialog focus", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps focus in a typed field when the parent re-renders", async () => {
    const tree = (onClose: () => void) => createElement(Dialog, {
      title: "Custom formula",
      onClose,
      children: createElement("input", { "aria-label": "script name" }),
    });

    await act(async () => {
      root.render(tree(() => undefined));
    });
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="script name"]');
    expect(input).not.toBeNull();
    input?.focus();
    expect(document.activeElement).toBe(input);

    // A new callback identity is what setParam does on every letter.
    await act(async () => {
      root.render(tree(() => undefined));
    });
    expect(document.activeElement).toBe(input);
  });
});