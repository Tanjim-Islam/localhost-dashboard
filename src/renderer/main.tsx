import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
