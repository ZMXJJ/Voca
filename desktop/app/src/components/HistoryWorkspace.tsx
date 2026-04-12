import type { TaskRecord } from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "./StatusBadge";

type HistoryWorkspaceProps = {
  currentTask: TaskRecord | null;
  taskHistory: TaskRecord[];
};

function getTaskTone(task: TaskRecord) {
  switch (task.status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    case "queued":
      return "warning";
    case "cancelled":
    default:
      return "muted";
  }
}

function formatTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function HistoryWorkspace({ currentTask, taskHistory }: HistoryWorkspaceProps) {
  const { t } = useTranslation();
  const latestTask = taskHistory[0] ?? currentTask;

  if (taskHistory.length === 0) {
    return (
      <section className="workspace-stack">
        <article className="panel history-empty-card">
          <div className="history-empty-card__icon">◌</div>
          <strong>{t("history.empty.title")}</strong>
          <p>{t("history.empty.description")}</p>
        </article>
      </section>
    );
  }

  return (
    <section className="workspace-stack">
      <div className="page-grid page-grid--history">
        <article className="panel summary-card">
          <p className="panel-kicker">{t("history.summary.kicker")}</p>
          <h2 className="section-title">{t("history.summary.title")}</h2>
          <p className="summary-card__copy">{t("history.summary.description")}</p>

          <div className="metrics-grid">
            <article className="panel metric-card">
              <span className="panel-kicker">{t("history.summary.totalTasks")}</span>
              <strong>{taskHistory.length}</strong>
              <p>{t("history.summary.totalTasksBody")}</p>
            </article>

            <article className="panel metric-card">
              <span className="panel-kicker">{t("history.summary.latestStatus")}</span>
              <strong>{latestTask ? t(`common.taskStatus.${latestTask.status}`) : "--"}</strong>
              <p>{latestTask ? formatTime(latestTask.updatedAt) : t("history.summary.timeFallback")}</p>
            </article>
          </div>
        </article>

        <article className="panel history-list-card">
          <div className="section-head section-head--tight">
            <div>
              <p className="panel-kicker">{t("history.list.kicker")}</p>
              <h2 className="section-title">{t("history.list.title")}</h2>
            </div>
            <StatusBadge tone="muted">{t("history.list.sessionScope")}</StatusBadge>
          </div>

          <div className="history-list">
            {taskHistory.map((task) => (
              <article key={task.id} className="history-item">
                <div className="history-item__top">
                  <div>
                    <strong>{t(`common.taskStatus.${task.status}`)}</strong>
                    <p>{t(`history.type.${task.type}`)}</p>
                  </div>
                  <StatusBadge tone={getTaskTone(task)}>{t(`common.taskStatus.${task.status}`)}</StatusBadge>
                </div>

                <dl className="history-meta">
                  <div>
                    <dt>{t("history.item.createdAt")}</dt>
                    <dd>{formatTime(task.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>{t("history.item.updatedAt")}</dt>
                    <dd>{formatTime(task.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt>{t("history.item.progress")}</dt>
                    <dd>{task.progress !== undefined ? `${task.progress}%` : "--"}</dd>
                  </div>
                </dl>

                <div className="history-item__body">
                  {task.result?.audioPath ? (
                    <p>
                      {t("history.item.audioPath")}: {task.result.audioPath}
                    </p>
                  ) : task.error?.message ? (
                    <p>
                      {t("history.item.error")}: {task.error.message}
                    </p>
                  ) : (
                    <p>{task.message ?? t("history.item.messageFallback")}</p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
