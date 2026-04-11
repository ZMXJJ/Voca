import { useState } from "react";
import type { GenerationParams, TaskRecord } from "@voca/contracts";

type TaskPanelProps = {
  onSubmit: (payload: GenerationParams) => Promise<void>;
  currentTask: TaskRecord | null;
};

export function TaskPanel({ onSubmit, currentTask }: TaskPanelProps) {
  const [text, setText] = useState("欢迎使用 Voca。");
  const [controlInstruction, setControlInstruction] = useState("温柔、自然、偏年轻女性");

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

      <button
        className="primary-button"
        onClick={() =>
          onSubmit({
            mode: "voice_design",
            targetText: text,
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
