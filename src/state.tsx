// 全局项目选择状态：注册表 + 当前激活项目（localStorage 持久化）
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { api, type ProjectConfig } from "./api.js";

interface Ctx {
  projects: ProjectConfig[];
  active: ProjectConfig | null;
  setActiveId: (id: string) => void;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

const ProjectCtx = createContext<Ctx>({
  projects: [], active: null, setActiveId: () => {}, refresh: async () => {}, loading: false, error: null,
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeId, setId] = useState<string>(() => localStorage.getItem("acb-active-project") ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list: ProjectConfig[] = await api.listProjects();
      setProjects(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const active = projects.find((p) => p.projectId === activeId) ?? projects[projects.length - 1] ?? null;
  const setActiveId = (id: string) => {
    localStorage.setItem("acb-active-project", id);
    setId(id);
  };

  return (
    <ProjectCtx.Provider value={{ projects, active, setActiveId, refresh, loading, error }}>
      {children}
    </ProjectCtx.Provider>
  );
}

export const useProject = () => useContext(ProjectCtx);
