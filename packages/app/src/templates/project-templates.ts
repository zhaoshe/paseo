/**
 * Starter project templates shown in the onboarding gallery. Each template's
 * `scaffoldCommand` is run inside the freshly opened project directory to
 * generate it. The catalog is client-static — the daemon only needs to open the
 * directory and run the command, not know which templates exist.
 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** Shell command run inside the new project directory to scaffold it. */
  scaffoldCommand: string;
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "next",
    name: "Next.js",
    description: "React framework with the App Router and TypeScript.",
    scaffoldCommand: "npx -y create-next-app@latest .",
  },
  {
    id: "vite-react",
    name: "Vite + React",
    description: "Fast Vite dev server with React and TypeScript.",
    scaffoldCommand: "npm create -y vite@latest . -- --template react-ts",
  },
  {
    id: "expo",
    name: "Expo",
    description: "React Native universal app for iOS, Android, and web.",
    scaffoldCommand: "npx -y create-expo-app@latest .",
  },
  {
    id: "node-ts",
    name: "Node + TypeScript",
    description: "Minimal Node.js project preconfigured for TypeScript.",
    scaffoldCommand: "npm init -y && npm install -D typescript @types/node && npx tsc --init",
  },
];
