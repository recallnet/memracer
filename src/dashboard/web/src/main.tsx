import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardErrorBoundary } from "../components/error-boundary.js";
import { App } from "./app.js";
import "../styles/theme.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("dashboard root is missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DashboardErrorBoundary
        className="dashboard-shell root-boundary"
        heading="Dashboard couldn't load"
        message="A rendering error stopped the dashboard. Reload the page to try again."
      >
        <App />
      </DashboardErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);
