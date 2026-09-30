import { describe, expect, it } from "vitest";
import { routeKitchenItems, type RoutePrinter } from "./kitchenRouting";

const CAT: Record<string, string> = { burger: "c-grill", steak: "c-grill", fries: "c-fry", cola: "c-bar" };
const categoryOf = (id: string | undefined) => (id ? CAT[id] : undefined);
const item = (menuItemId?: string) => (menuItemId ? { menuItemId, name: menuItemId } : { name: "manual" });
const names = (m: Map<string, { name: string }[]>, id: string) => (m.get(id) ?? []).map((i) => i.name);

const grill: RoutePrinter = { id: "grill", categoryIds: ["c-grill"] };
const fryer: RoutePrinter = { id: "fryer", categoryIds: ["c-fry"] };
const expo: RoutePrinter = { id: "expo", categoryIds: [] };

describe("routeKitchenItems", () => {
  const order = [item("burger"), item("fries"), item("cola"), item("steak")];

  it("keeps the old behaviour when no printer has categories: everyone prints everything", () => {
    const r = routeKitchenItems(order, [expo, { id: "second", categoryIds: [] }], categoryOf);
    expect(names(r, "expo")).toEqual(["burger", "fries", "cola", "steak"]);
    expect(names(r, "second")).toEqual(["burger", "fries", "cola", "steak"]);
  });

  it("sends each station only its own categories, in order", () => {
    const r = routeKitchenItems(order, [grill, fryer, { id: "bar", categoryIds: ["c-bar"] }], categoryOf);
    expect(names(r, "grill")).toEqual(["burger", "steak"]);
    expect(names(r, "fryer")).toEqual(["fries"]);
    expect(names(r, "bar")).toEqual(["cola"]);
  });

  it("a printer with no categories stays a full-ticket printer next to the stations", () => {
    const r = routeKitchenItems(order, [grill, fryer, expo], categoryOf);
    expect(names(r, "grill")).toEqual(["burger", "steak"]);
    expect(names(r, "fryer")).toEqual(["fries"]);
    expect(names(r, "expo")).toEqual(["burger", "fries", "cola", "steak"]);
  });

  it("never drops an item nobody claims: it goes to the first printer", () => {
    const r = routeKitchenItems(order, [grill, fryer], categoryOf);
    expect(names(r, "grill")).toEqual(["burger", "cola", "steak"]);
    expect(names(r, "fryer")).toEqual(["fries"]);
  });

  it("an item without a menu item (manual line) also goes somewhere", () => {
    const r = routeKitchenItems([item()], [grill, fryer], categoryOf);
    expect(names(r, "grill")).toEqual(["manual"]);
    const withExpo = routeKitchenItems([item()], [grill, fryer, expo], categoryOf);
    expect(names(withExpo, "expo")).toEqual(["manual"]);
    expect(withExpo.has("grill")).toBe(false);
  });

  it("a category shared by two stations prints on both", () => {
    const both: RoutePrinter = { id: "both", categoryIds: ["c-grill", "c-fry"] };
    const r = routeKitchenItems([item("burger")], [grill, both], categoryOf);
    expect(names(r, "grill")).toEqual(["burger"]);
    expect(names(r, "both")).toEqual(["burger"]);
  });

  it("a station with nothing to cook is left out, so it prints no empty ticket", () => {
    const r = routeKitchenItems([item("fries")], [grill, fryer], categoryOf);
    expect(r.has("grill")).toBe(false);
    expect(names(r, "fryer")).toEqual(["fries"]);
  });

  it("no printers means nothing to route", () => {
    expect(routeKitchenItems(order, [], categoryOf).size).toBe(0);
  });
});
