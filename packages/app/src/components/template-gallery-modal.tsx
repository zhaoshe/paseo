import { memo, useCallback } from "react";
import { Pressable, type PressableStateCallbackType, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PROJECT_TEMPLATES, type ProjectTemplate } from "@/templates/project-templates";

export interface TemplateGalleryModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (template: ProjectTemplate) => void;
  testID?: string;
}

const HEADER: SheetHeader = { title: "Start from a template" };
const SNAP_POINTS: string[] = ["70%", "90%"];

function rowStyle({ pressed }: PressableStateCallbackType): Array<object | false> {
  return [styles.row, pressed && styles.rowPressed];
}

const TemplateRow = memo(function TemplateRow({
  template,
  onSelect,
}: {
  template: ProjectTemplate;
  onSelect: (template: ProjectTemplate) => void;
}) {
  const handlePress = useCallback(() => onSelect(template), [onSelect, template]);
  return (
    <Pressable style={rowStyle} onPress={handlePress} testID={`template-${template.id}`}>
      <Text style={styles.name}>{template.name}</Text>
      <Text style={styles.description}>{template.description}</Text>
      <View style={styles.commandPill}>
        <Text style={styles.commandText} numberOfLines={1}>
          {template.scaffoldCommand}
        </Text>
      </View>
    </Pressable>
  );
});

export function TemplateGalleryModal({
  visible,
  onClose,
  onSelect,
  testID,
}: TemplateGalleryModalProps) {
  return (
    <AdaptiveModalSheet
      header={HEADER}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={560}
      testID={testID}
    >
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={styles.intro}>
          Pick a folder for your project, then run the copied command in a terminal to scaffold it.
        </Text>
        {PROJECT_TEMPLATES.map((template) => (
          <TemplateRow key={template.id} template={template} onSelect={onSelect} />
        ))}
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  intro: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  row: {
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    gap: theme.spacing[2],
  },
  rowPressed: {
    opacity: 0.85,
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  commandPill: {
    marginTop: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
  },
  commandText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
