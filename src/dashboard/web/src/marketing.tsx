import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MarketingFaq } from "../components/marketing-faq.js";
import { MarketingHome } from "../components/marketing-home.js";
import "../styles/theme.css";
import "../styles/marketing.css";

const root = document.getElementById("root");
if (!root) throw new Error("marketing root is missing");

const path = typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") || "/" : "/";
const page = path === "/faq" ? <MarketingFaq /> : <MarketingHome />;

createRoot(root).render(
  <StrictMode>
    {page}
  </StrictMode>,
);
