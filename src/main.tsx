import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./phone.css";
import { syncWindowTheme } from "./lib/theme";
import { useLang } from "./lib/i18n";

syncWindowTheme();

/** Redraws the whole app when the language changes. A re-render, not a remount: App connects to the
 * service when it mounts, and open dialogs keep what was typed. (No component is memoized, so the
 * new texts reach every one of them.) */
function Root() {
  useLang();
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
