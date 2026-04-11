import { useState } from "react";
import type {
  GenerationParams,
  ModelPrepareResponse,
  ProviderRecommendation,
  TaskRecord,
} from "@voca/contracts";

type TaskPanelProps = {
  onSubmit: (payload: GenerationParams) => Promise<void>;
  onPrepareModel: (
    modelKey: string,
    providerPreference: "auto" | "huggingface" | "modelscope",
    ensureDownloaded: boolean,
  ) => Promise<void>;
  currentTask: TaskRecord | null;
  providerRecommendation: ProviderRecommendation | null;
  preparedModel: ModelPrepareResponse | null;
};

export function TaskPanel({
  onSubmit,
  onPrepareModel,
  currentTask,
  providerRecommendation,
  preparedModel,
}: TaskPanelProps) {
  const [text, setText] = useState("欢迎使用 Voca。");
  const [controlInstruction, setControlInstruction] = useState("温柔、自然、偏年轻女性");
  const [modelKey, setModelKey] = useState("voxcpm2-default");
  const [providerPreference, setProviderPreference] = useState<"auto" | "huggingface" | "modelscope">("auto");

  return (
    <section className="task-panel">
      <div className="task-panel__header">
        <h2>快速生成</h2>
        <p>这里先保留 P0 所需的最小文本生成链路，后续再扩到声音设计和声音克隆。</p>
      </div>

      <label className="field">
        <span>目标文本</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          placeholder="请输入要生成的文本"
        />
      </label>

      <label className="field">
        <span>音色描述</span>
        <input
          value={controlInstruction}
          onChange={(event) => setControlInstruction(event.target.value)}
          placeholder="例如：温柔、自然、偏年轻女性"
        />
      </label>

      <div className="field-grid">
        <label className="field">
          <span>模型版本</span>
          <select value={modelKey} onChange={(event) => setModelKey(event.target.value)}>
            <option value="voxcpm2-default">VoxCPM2</option>
            <option value="voxcpm1.5-default">VoxCPM1.5</option>
            <option value="voxcpm-0.5b-default">VoxCPM-0.5B</option>
          </select>
        </label>

        <label className="field">
          <span>下载源策略</span>
          <select
            value={providerPreference}
            onChange={(event) =>
              setProviderPreference(event.target.value as "auto" | "huggingface" | "modelscope")
            }
          >
            <option value="auto">自动选择（按 IP 推荐）</option>
            <option value="huggingface">固定 Hugging Face</option>
            <option value="modelscope">固定魔搭社区</option>
          </select>
        </label>
      </div>

      <p className="inline-hint">
        当下载源策略为自动时，sidecar 会优先查询公网 IP，并通过百度 IP 地址查询接口判断地区；若命中中国大陆网络环境，则默认优先选择魔搭社区，否则默认选择 Hugging Face。
      </p>

      <div className="prepare-panel">
        <div>
          <strong>当前推荐：</strong>{" "}
          {providerRecommendation
            ? `${providerRecommendation.current}${providerRecommendation.location ? ` (${providerRecommendation.location})` : ""}`
            : "尚未获取"}
        </div>
        <div>
          <strong>模型状态：</strong>{" "}
          {preparedModel
            ? preparedModel.configExists
              ? `已就绪，路径：${preparedModel.modelPath}`
              : `未准备，目标目录：${preparedModel.modelPath}`
            : "尚未检查"}
        </div>
      </div>

      <div className="button-row">
        <button
          className="secondary-button"
          onClick={() => onPrepareModel(modelKey, providerPreference, false)}
        >
          检查模型状态
        </button>
        <button
          className="secondary-button"
          onClick={() => onPrepareModel(modelKey, providerPreference, true)}
        >
          准备模型（会触发下载）
        </button>
      </div>

      <button
        className="primary-button"
        onClick={() =>
          onSubmit({
            mode: "voice_design",
            targetText: text,
            modelKey,
            providerPreference,
            controlInstruction,
            cfgValue: 2.0,
            inferenceTimesteps: 10,
            normalize: true,
            denoise: true,
            streaming: false,
          })
        }
      >
        发起生成任务
      </button>

      <div className="task-panel__result">
        <h3>当前任务</h3>
        {currentTask ? (
          <pre>{JSON.stringify(currentTask, null, 2)}</pre>
        ) : (
          <p>尚未提交任务。后续这里会接入真实任务状态、试听和导出区域。</p>
        )}
      </div>
    </section>
  );
}
