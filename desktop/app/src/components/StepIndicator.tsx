import { IconCheck } from "./Icons";

type Step = {
  label: string;
  status: "done" | "active" | "pending";
};

type StepIndicatorProps = {
  steps: Step[];
};

export function StepIndicator({ steps }: StepIndicatorProps) {
  return (
    <div className="step-indicator">
      {steps.map((step, index) => (
        <div key={step.label} style={{ display: "contents" }}>
          {index > 0 && <div className="step-indicator__line" />}
          <div className="step-indicator__item">
            <div className={`step-indicator__circle step-indicator__circle--${step.status}`}>
              {step.status === "done" ? <IconCheck size={12} /> : index + 1}
            </div>
            <span className={`step-indicator__label step-indicator__label--${step.status}`}>
              {step.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
