import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // Build output and generated artifacts. `dist-electron/` holds the packaged
    // Electron app (including the standalone Next server and its bundled
    // node_modules), so linting it produces tens of thousands of false errors.
    ignores: [
      "dist-electron/**",
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "desktop/node-runtime/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Electron main-process scripts are CommonJS by design (.cjs) — `require`
    // is the only way to load them (Node does not auto-resolve .cjs via import).
    files: ["desktop/**/*.cjs", "desktop/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];

export default eslintConfig;
