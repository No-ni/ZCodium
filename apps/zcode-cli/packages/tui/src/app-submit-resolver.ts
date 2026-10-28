import { useCallback } from "react";
import { selectedSlashCommand } from "./app-input.js";
import { modelOptionValue } from "./app-model-ref.js";
import type { SlashCommand, SlashSelectionState } from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

export function useComposerSubmittedText(input: {
  modelCommand: { selectedOption(value: string): TuiModelOption | undefined };
  effortCommand: { selectedOption(value: string): TuiEffortOption | undefined };
  modeCommand: { selectedOption(value: string): TuiModeOption | undefined };
  filteredSlashCommands: readonly SlashCommand[];
  slashSelection: SlashSelectionState | undefined;
}): (value: string) => string {
  return useCallback(
    (submittedValue: string) => {
      const modelOption = input.modelCommand.selectedOption(submittedValue);
      const effortOption = modelOption
        ? undefined
        : input.effortCommand.selectedOption(submittedValue);
      return resolveComposerSubmittedText({
        effortOption,
        modeOption:
          modelOption || effortOption
            ? undefined
            : input.modeCommand.selectedOption(submittedValue),
        modelOption,
        slashCommands: input.filteredSlashCommands,
        slashSelection: input.slashSelection,
        submittedValue,
      });
    },
    [input],
  );
}

export function resolveComposerSubmittedText({
  effortOption,
  modeOption,
  modelOption,
  slashCommands,
  slashSelection,
  submittedValue,
}: {
  effortOption?: TuiEffortOption;
  modeOption?: TuiModeOption;
  modelOption?: TuiModelOption;
  slashCommands: readonly SlashCommand[];
  slashSelection?: SlashSelectionState;
  submittedValue: string;
}): string {
  const slashCommand = selectedSlashCommand(submittedValue, slashSelection, slashCommands);
  if (modelOption) return `/model ${modelOptionValue(modelOption)}`;
  if (effortOption) return `/effort ${effortOption.id}`;
  if (modeOption) return `/mode ${modeOption.id}`;
  if (slashCommand) {
    // 同批追加字符后建议仍可能是旧 /quit；只有当前原文仍是合法单词前缀才可确认退出补全。
    if (
      slashCommand.name.toLowerCase() === "quit" &&
      !/^\/(?:q|qu|qui|quit)?$/i.test(submittedValue)
    )
      return submittedValue;
    return `/${slashCommand.name}`;
  }
  return submittedValue;
}
