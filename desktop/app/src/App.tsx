import { useEffect, useState } from "react";
import type { BootstrapState, SidecarStatus, TaskRecord } from "@voca/contracts";
import { HomePage } from "./pages/HomePage";
import { createGenerateTask, getBootstrapState, getSidecarStatus } from "./lib/tauri";

function App() {
  const [bootstrapState, setBootstrapState] = useState<BootstrapState | null>(null);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>({
    running: false,
    healthy: false,
    reason: "loading",
  });
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);

  useEffect(() => {
    void getBootstrapState().then(setBootstrapState);
    void getSidecarStatus().then(setSidecarStatus);
  }, []);

  if (!bootstrapState) {
    return <main className="loading-screen">正在加载 Voca 桌面骨架...</main>;
  }

  return (
    <HomePage
      bootstrapState={bootstrapState}
      sidecarStatus={sidecarStatus}
      currentTask={currentTask}
      onSubmitTask={async (payload) => {
        const task = await createGenerateTask(payload);
        setCurrentTask(task);
      }}
    />
  );
}

export default App;
