import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";

export type GroupedTaskLocation =
  | {
      parent: "root";
      nodeIndex: number;
      task: ZCodeTaskMeta;
    }
  | {
      parent: "group";
      groupId: string;
      nodeIndex: number;
      taskIndex: number;
      task: ZCodeTaskMeta;
    };

export type GroupedTaskInsertPosition = "before" | "after";
