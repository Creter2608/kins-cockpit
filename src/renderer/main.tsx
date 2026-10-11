import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { CockpitErrorBoundary } from "./components/CockpitErrorBoundary.js";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <CockpitErrorBoundary>
        <App />
      </CockpitErrorBoundary>
    </React.StrictMode>
  );
}
