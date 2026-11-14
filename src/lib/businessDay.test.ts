import { describe, expect, it } from "vitest";
import { businessDayStart, businessPeriodStart } from "./businessDay";

const at = (s: string) => new Date(s);

describe("business day", () => {
  it("starts at 05:00 local time", () => {
    expect(businessDayStart(at("2026-11-14T14:00:00"))).toEqual(at("2026-11-14T05:00:00"));
    expect(businessDayStart(at("2026-11-14T05:00:00"))).toEqual(at("2026-11-14T05:00:00"));
  });
  it("keeps the hours after midnight in the previous day", () => {
    expect(businessDayStart(at("2026-11-15T00:30:00"))).toEqual(at("2026-11-14T05:00:00"));
    expect(businessDayStart(at("2026-11-15T04:59:00"))).toEqual(at("2026-11-14T05:00:00"));
  });
  it("weeks and months start on a business day too", () => {
    // 2026-11-14 is a Saturday; its week began Sunday 2026-11-08.
    expect(businessPeriodStart("week", at("2026-11-14T12:00:00"))).toEqual(at("2026-11-08T05:00:00"));
    expect(businessPeriodStart("month", at("2026-11-14T12:00:00"))).toEqual(at("2026-11-01T05:00:00"));
    // 02:00 on 1 December is still the last business day of November.
    expect(businessPeriodStart("month", at("2026-12-01T02:00:00"))).toEqual(at("2026-11-01T05:00:00"));
  });
});
