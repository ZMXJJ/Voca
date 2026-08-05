import type { TaskRecord } from "@voca/contracts";

export function getTaskPlayableAudioPath(task: TaskRecord): string | null {
  return task.result?.audioPath ?? task.result?.enhancedAudioPath ?? task.result?.rawAudioPath ?? null;
}
