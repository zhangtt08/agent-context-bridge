import { useEffect, useState } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Rail } from "./components/Shell";
import { ProjectProvider } from "./state";
import Dashboard from "./pages/Dashboard";
import CreateHandoff from "./pages/CreateHandoff";
import HandoffDetail from "./pages/HandoffDetail";
import Resume from "./pages/Resume";
import Settings from "./pages/Settings";

type Theme = "light" | "dark";

const initialTheme = (): Theme =>
  localStorage.getItem("acb-theme") === "dark" ? "dark" : "light";

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("acb-theme", theme);
  }, [theme]);

  return (
    <ProjectProvider>
      <HashRouter>
        <div className="app">
          <Rail theme={theme} onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))} />
          <div className="main">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/create" element={<CreateHandoff />} />
              <Route path="/handoff/:id" element={<HandoffDetail />} />
              <Route path="/resume" element={<Resume />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </div>
      </HashRouter>
    </ProjectProvider>
  );
}
