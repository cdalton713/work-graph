import { describe, expect, it } from "vitest";
import { parseOptions } from "./options";

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
