import type {
  BootstrapState,
  ModelPrepareResponse,
  ProviderRecommendation,
  SidecarStatus,
  TaskRecord,
} from "@voca/contracts";
import { StatusCard } from "../components/StatusCard";
import { TaskPanel } from "../components/TaskPanel";

type HomePageProps = {
  bootstrapState: BootstrapState;
  sidecarStatus: SidecarStatus;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
  currentTask: TaskRecord | null;
  onSubmitTask: Parameters<typeof TaskPanel>[0]["onSubmit"];
  onPrepareModel: Parameters<typeof TaskPanel>[0]["onPrepareModel"];
};

export function HomePage({
  bootstrapState,
  sidecarStatus,
  providerRecommendation,
  preparedModel,
  currentTask,
  onSubmitTask,
  onPrepareModel,
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
        <StatusCard
          title="Provider 推荐"
          value={providerRecommendation?.current ?? "unknown"}
          hint={
            providerRecommendation?.location
              ? `位置：${providerRecommendation.location}`
              : "后续会根据公网 IP 与下载策略计算推荐源"
          }
        />
        <StatusCard
          title="模型准备状态"
          value={
            preparedModel
              ? preparedModel.configExists
                ? "model ready"
                : "model missing"
              : "unchecked"
          }
          hint={preparedModel ? preparedModel.modelPath : "尚未检查本地模型目录"}
        />
      </section>

      <TaskPanel
        onSubmit={onSubmitTask}
        currentTask={currentTask}
        providerRecommendation={providerRecommendation}
        preparedModel={preparedModel}
        onPrepareModel={onPrepareModel}
      />
    </main>
  );
}
