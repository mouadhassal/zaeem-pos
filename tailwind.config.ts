import type { Config } from "tailwindcss";
import preset from "./tailwind-preset.js";

const config: Config = {
  presets: [preset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
};

export default config;
