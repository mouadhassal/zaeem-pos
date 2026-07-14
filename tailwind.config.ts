import type { Config } from "tailwindcss";
import preset from "@zaeem/types/tailwind-preset";

const config: Config = {
  presets: [preset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
};

export default config;
