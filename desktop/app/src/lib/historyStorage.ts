import type { TaskRecord } from "@voca/contracts";

const TASK_HISTORY_STORAGE_KEY = "voca.taskHistory.v1";
const TASK_HISTORY_LIMIT = 50;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskRecordLike(value: unknown): value is TaskRecord {
  if (!isObjectLike(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function sortTaskHistory(history: TaskRecord[]) {
  return [...history].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

export function normalizeTaskHistory(history: TaskRecord[]) {
  return sortTaskHistory(history).slice(0, TASK_HISTORY_LIMIT);
}

export function getTaskPlayableAudioPath(task: TaskRecord): string | null {
  return task.result?.audioPath ?? task.result?.enhancedAudioPath ?? task.result?.rawAudioPath ?? null;
}

export function loadPersistedTaskHistory(): TaskRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(TASK_HISTORY_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeTaskHistory(parsed.filter(isTaskRecordLike));
  } catch {
    return [];
  }
}

export function savePersistedTaskHistory(history: TaskRecord[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(TASK_HISTORY_STORAGE_KEY, JSON.stringify(normalizeTaskHistory(history)));
  } catch {
    // Ignore local persistence failures so history never blocks task flow.
  }
}
