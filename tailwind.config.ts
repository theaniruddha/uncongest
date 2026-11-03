import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1e293b",
        navy: "#0f2a43",
        teal: "#0d9488",
        sand: "#f7f5f0",
        amber: "#d97706"
      }
    }
  },
  plugins: []
};
export default config;
