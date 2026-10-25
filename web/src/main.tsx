import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"

import "./index.css"
import { App } from "./App.tsx"
import { Toaster } from "@/components/ui/sonner"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={new QueryClient()}>
        <App />
        <Toaster richColors />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
