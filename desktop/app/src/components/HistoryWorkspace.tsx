import { useEffect, useMemo, useState } from "react";
import type { TaskRecord } from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { listTasks } from "../lib/tauri";
import { AudioPlayer } from "./AudioPlayer";
import { IconPlay } from "./Icons";

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `今天 ${time}`;
  if (isYesterday) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function formatDuration(ms?: number) {
  if (!ms) return "0:00";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function statusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case "succeeded":
      return t("history.status.succeeded");
    case "failed":
      return t("history.status.failed");
    case "running":
      return t("history.status.running");
    case "queued":
      return t("history.status.queued");
    case "cancelled":
      return t("history.status.cancelled");
    default:
      return status;
  }
}

export function HistoryWorkspace() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    void listTasks(50, 0).then(setTasks);
  }, []);

  const selectedAudioPath = useMemo(() => {
    if (!selectedTaskId) return null;
    const task = tasks.find((t) => t.id === selectedTaskId);
    return task?.result?.audioPath ?? null;
  }, [selectedTaskId, tasks]);

  if (tasks.length === 0) {
    return (
      <>
        <h1 className="settings-title">{t("history.title")}</h1>
        <div className="coming-soon">
          <p className="coming-soon__desc">{t("history.empty")}</p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="settings-title">{t("history.title")}</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card__header">
          <h3 className="card__title">{t("history.allTasks")}</h3>
          <span className="card__count">{tasks.length}</span>
        </div>
        <div className="card__body">
          <div className="history-list">
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`history-item${selectedTaskId === task.id ? " history-item--selected" : ""}`}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <div className="history-item__play"><IconPlay size={12} /></div>
                <div className="history-item__info">
                  <div className="history-item__text">
                    {task.message || t("history.untitled")}
                  </div>
                  <div className="history-item__meta">
                    {formatHistoryTime(task.createdAt)}
                    {" · "}
                    {task.result?.durationMs ? formatDuration(task.result.durationMs) : statusLabel(task.status, t)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <AudioPlayer audioPath={selectedAudioPath} />
    </>
  );
}
