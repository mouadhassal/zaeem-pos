// Vendored from ../../packages/types/tailwind-preset.js -- this repo has
// its own separate git history/remote (see AGENTS.md) and can't resolve
// `@zaeem/types` as a workspace:* dependency when checked out standalone.
/** @type {import('tailwindcss').Config} */
const preset = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        canvas: "var(--bg)",
        surface: "var(--surface)",
        "surface-alt": "var(--surface-alt)",
        "panel-footer": "var(--panel-footer)",
        text: {
          DEFAULT: "var(--text)",
          2: "var(--text-2)",
          3: "var(--text-3)",
          muted: "var(--text-muted)",
        },
        line: {
          DEFAULT: "var(--line)",
          2: "var(--line-2)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          text: "var(--accent-text)",
        },
        ok: {
          DEFAULT: "var(--ok)",
          soft: "var(--ok-soft)",
        },
        warn: {
          DEFAULT: "var(--warn)",
          soft: "var(--warn-soft)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
        },
        // Secondary accent only (tags, muted chart segments) -- never
        // primary actions, per ZAEEM_DESIGN_SYSTEM.md §1's discipline rule.
        brown: "var(--brown)",
        ink: {
          50: "var(--ink-50)",
          100: "var(--ink-100)",
          200: "var(--ink-200)",
          300: "var(--ink-300)",
          400: "var(--ink-400)",
          500: "var(--ink-500)",
          600: "var(--ink-600)",
          700: "var(--ink-700)",
          800: "var(--ink-800)",
          900: "var(--ink-900)",
        },
        saffron: {
          50: "var(--saffron-50)",
          100: "var(--saffron-100)",
          200: "var(--saffron-200)",
          300: "var(--saffron-300)",
          400: "var(--saffron-400)",
          500: "var(--saffron-500)",
          600: "var(--saffron-600)",
          700: "var(--saffron-700)",
          800: "var(--saffron-800)",
          900: "var(--saffron-900)",
        },
        live: {
          50: "var(--live-50)",
          100: "var(--live-100)",
          200: "var(--live-200)",
          300: "var(--live-300)",
          400: "var(--live-400)",
          500: "var(--live-500)",
          600: "var(--live-600)",
          700: "var(--live-700)",
          800: "var(--live-800)",
          900: "var(--live-900)",
        },
      },
      fontFamily: {
        // ZAEEM_DESIGN_SYSTEM.md §2: Manrope/Cairo body, Poppins/Cairo
        // headings, IBM Plex Mono for every numeral (always, even in RTL).
        sans: ["Manrope", "Cairo", "system-ui", "sans-serif"],
        arabic: ["Cairo", "sans-serif"],
        heading: ["Poppins", "Cairo", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "8px",
        md: "8px",
        lg: "12px",
        xl: "12px",
        "2xl": "16px",
      },
      boxShadow: {
        "sh-1": "0 1px 2px rgba(28,25,23,.04)",
        "sh-2": "0 1px 2px rgba(28,25,23,.04), 0 1px 3px rgba(28,25,23,.06)",
        "sh-3": "0 20px 25px -5px rgba(28,25,23,.08), 0 10px 10px -5px rgba(28,25,23,.04)",
      },
    },
  },
  plugins: [],
};

module.exports = preset;
