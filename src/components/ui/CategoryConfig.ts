import {
  IconMeat, IconFlame, IconCup, IconSalad, IconCake, IconBox,
  type Icon,
} from "@tabler/icons-react";

export interface CategoryStyle {
  wash: string;
  /** Deeper shade of `wash`, same hue -- gradient endpoint for the no-photo tile. */
  washDeep: string;
  icon: Icon;
  glyphColor: string;
}

export const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  meat:    { wash: "#FDEDE8", washDeep: "#FAD9CE", icon: IconMeat,  glyphColor: "#F04E23" },
  grill:   { wash: "#FBF0DE", washDeep: "#F5DFAF", icon: IconFlame, glyphColor: "#C4841D" },
  drink:   { wash: "#E8F1FB", washDeep: "#CFE3F7", icon: IconCup,   glyphColor: "#3E8BD8" },
  salad:   { wash: "#E9F4EE", washDeep: "#CFEADA", icon: IconSalad, glyphColor: "#2E8B5B" },
  sweet:   { wash: "#F3EDFB", washDeep: "#E3D3F5", icon: IconCake,  glyphColor: "#7B5BC4" },
  other:   { wash: "#F2F4F7", washDeep: "#E1E5EA", icon: IconBox,   glyphColor: "#667085" },
};

export function getCategoryStyle(categoryName: string): CategoryStyle {
  const key = categoryName?.toLowerCase().trim() || "other";
  const styles: Record<string, string> = {
    "meat": "meat", "لحوم": "meat", "steak": "meat", "chicken": "meat", "دجاج": "meat",
    "grill": "grill", "مشاوي": "grill", "burgers": "grill", "برغر": "grill", "شاورما": "grill",
    "drink": "drink", "مشروبات": "drink", "juice": "drink", "عصير": "drink", "soft drinks": "drink", "water": "drink",
    "salad": "salad", "سلطات": "salad", "appetizer": "salad", "مقبلات": "salad",
    "sweet": "sweet", "حلويات": "sweet", "dessert": "sweet", "ice cream": "sweet", "آيس كريم": "sweet",
  };
  const matched = styles[key];
  return CATEGORY_STYLES[matched || "other"];
}
