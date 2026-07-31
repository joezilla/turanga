import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".claude/**", "**/dist/**", "**/build/**", "**/.svelte-kit/**", "**/node_modules/**", "_bmad/**", "_bmad-output/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
