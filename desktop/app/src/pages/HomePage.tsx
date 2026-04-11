import type { BootstrapState, SidecarStatus, TaskRecord } from "@voca/contracts";
import { StatusCard } from "../components/StatusCard";
import { TaskPanel } from "../components/TaskPanel";

type HomePageProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  currentTask: TaskRecord | null;
  onSubmitTask: Parameters<typeof TaskPanel>[0]["onSubmit"];
};

export function HomePage({
  bootstrapState,
  sidecarStatus,
  currentTask,
  onSubmitTask,
}: HomePageProps) {
  return (
    <main className="page-shell">
      <section className="hero-section">
        <div>
          <div className="eyebrow">Voca P0 Desktop Skeleton</div>
          <h1>本地语音生成桌面框架</h1>
          <p>
            当前页面聚焦 P0 所需的最小闭环：读取初始化状态、感知 sidecar 状态、发起一条文本生成任务，并展示任务结果占位。
          </p>
        </div>
      </section>

      <section className="status-grid">
        <StatusCard
          title="初始化阶段"
          value={bootstrapState.phase}
          hint={`状态：${bootstrapState.status}`}
        />
        <StatusCard
          title="运行时 / 模型"
          value={`${bootstrapState.runtimeReady ? "runtime ready" : "runtime pending"} / ${
            bootstrapState.modelReady ? "model ready" : "model pending"
          }`}
          hint="后续会接入真实下载与校验流程"
        />
        <StatusCard
          title="Python Sidecar"
          value={sidecarStatus.running ? "running" : "offline"}
          hint={sidecarStatus.healthy ? "health check ok" : sidecarStatus.reason ?? "waiting"}
        />
      </section>

      <TaskPanel onSubmit={onSubmitTask} currentTask={currentTask} />
    </main>
  );
}
