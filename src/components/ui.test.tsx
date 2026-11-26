import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Picker } from "./ui";

const screen = vi.hoisted(() => ({ narrow: false, coarse: false }));
vi.mock("../lib/screen", () => ({
  useNarrow: () => screen.narrow,
  useCoarse: () => screen.coarse,
  useHover: () => !screen.coarse,
}));

describe("Picker trigger", () => {
  it.each([
    { narrow: true, coarse: true, popup: "dialog" },
    { narrow: true, coarse: false, popup: "listbox" },
    { narrow: false, coarse: true, popup: "listbox" },
    { narrow: false, coarse: false, popup: "listbox" },
  ])("announces $popup on a screen with narrow=$narrow and coarse=$coarse", ({ narrow, coarse, popup }) => {
    Object.assign(screen, { narrow, coarse });
    const markup = renderToStaticMarkup(
      <Picker options={[{ id: "ready", label: "Ready" }]} value={["ready"]} onChange={() => {}}>Ready</Picker>,
    );
    expect(markup).toContain(`aria-haspopup="${popup}"`);
    expect(markup).toContain('aria-expanded="false"');
  });
});
