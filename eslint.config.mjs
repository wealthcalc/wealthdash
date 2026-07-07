import react from "eslint-plugin-react";
import globals from "globals";
export default [{
  files: ["**/*.jsx", "**/*.mjs"],
  plugins: { react },
  languageOptions: {
    ecmaVersion: 2024, sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: { ...globals.browser, ...globals.node },
  },
  rules: { "no-undef": "error", "react/jsx-no-undef": "error" },
}];
