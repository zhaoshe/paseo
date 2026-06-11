import { useCallback } from "react";
import * as Clipboard from "expo-clipboard";
import { useToast } from "@/contexts/toast-context";
import { pickDirectory } from "@/desktop/pick-directory";
import { useOpenProject } from "@/hooks/use-open-project";
import type { ProjectTemplate } from "@/templates/project-templates";

/**
 * Onboarding scaffold flow: pick an (ideally empty) folder, open it as a
 * project, and copy the template's scaffold command to the clipboard so the
 * user can run it in a terminal to generate the project. Reuses the existing
 * folder picker and open-project flow — no new daemon capability required.
 */
export function useScaffoldFromTemplate(
  serverId: string,
): (template: ProjectTemplate) => Promise<void> {
  const openProject = useOpenProject(serverId);
  const toast = useToast();

  return useCallback(
    async (template: ProjectTemplate) => {
      let directory: string | null;
      try {
        directory = await pickDirectory();
      } catch {
        toast.error("Choosing a folder is only available in the desktop app.");
        return;
      }
      if (!directory) {
        return;
      }
      const opened = await openProject(directory);
      if (!opened) {
        toast.error("Could not open the selected folder.");
        return;
      }
      await Clipboard.setStringAsync(template.scaffoldCommand);
      toast.copied(`${template.name} scaffold command`);
    },
    [openProject, toast],
  );
}
