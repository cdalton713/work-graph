import { describe, expect, it } from "vitest";
import { optionForKey, parseOptions } from "./options";

const choices = "Options:\n- Wait: Keep the current schedule.\n- Ship: Start today. (Recommended: The checks passed.)";

describe("parseOptions", () => {
  it("returns the question and puts the recommendation first", () => {
    expect(parseOptions(`When should we start?\r\n\r\n${choices}\r\n`)).toEqual({
      question: "When should we start?",
      options: [
        { label: "Ship", effect: "Start today.", reason: "The checks passed." },
        { label: "Wait", effect: "Keep the current schedule." },
      ],
    });
  });

  it.each([
    "When should we start?",
    `Question\n\n${choices}\nMore text.`,
    `Question\n\n${choices.replace("Wait:", "Wait")}`,
    `Question\n\n${choices.replace(" (Recommended: The checks passed.)", "")}`,
    `Question\n\n${choices.replace("Keep the current schedule.", "Stay here. (Recommended: It is ready.)")}`,
    `Question\n\n${choices.replace("Wait:", "Ship:")}`,
    `Question\n\n${choices}\n- Later: Rest.\n- Tomorrow: Check again.\n- Tonight: Close early.`,
  ])("preserves the original prompt when there is no valid block", (question) => {
    expect(parseOptions(question)).toEqual({ question, options: [] });
  });
});

describe("optionForKey", () => {
  const { options } = parseOptions(`When should we start?\n\n${choices}`);
  const key = { code: "Digit1", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false };

  it("selects the numbered option in display order when the options have focus", () => {
    expect(optionForKey(key, options, true)?.label).toBe("Ship");
    expect(optionForKey({ ...key, code: "Digit2" }, options, true)?.label).toBe("Wait");
  });

  it("leaves Option plus a digit alone when the text box has focus", () => {
    expect(optionForKey(key, options, false)).toBeUndefined();
  });

  it("leaves an existing draft alone when the options have focus", () => {
    expect(optionForKey(key, options, true, "My draft")).toBeUndefined();
  });

  it.each([
    { altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
    { repeat: true }, { isComposing: true }, { code: "Digit3" }, { code: "Digit5" },
  ])("ignores keys outside the option shortcuts", (fields) => {
    expect(optionForKey({ ...key, ...fields }, options, true)).toBeUndefined();
  });
});
