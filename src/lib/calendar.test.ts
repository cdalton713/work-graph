import { expect, it } from "vitest";
import { addDays, dateSummary, monthGrid, nextWeekday, quickDates } from "./calendar";

it("shows six weeks from the Sunday on or before the first day", () => {
  const grid = monthGrid(2026, 10); // November 2026 starts on a Sunday
  expect([grid.length, grid[0], grid[41]]).toEqual([42, "2026-11-01", "2026-12-12"]);
  expect(monthGrid(2026, 11)[0]).toBe("2026-11-29");
});

it("gives quick picks after today, across a month end", () => {
  expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  expect(nextWeekday("2026-11-27", 1)).toBe("2026-11-30");
  expect(nextWeekday("2026-11-30", 1)).toBe("2026-12-07");
  expect(quickDates("2026-11-27").map((q) => q.date)).toEqual(["2026-11-28", "2026-11-30", "2026-12-04", "2026-12-07"]);
  expect(dateSummary("2026-12-07", "2026-11-27")).toMatch(/· in 10 days$/);
});
