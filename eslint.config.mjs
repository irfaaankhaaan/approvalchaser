import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * eslint-config-next 16 ships native flat config, so it is spread in directly
 * rather than run through the eslintrc compatibility shim.
 */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      ".pgdata/**",
      "coverage/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
