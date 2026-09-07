import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { dashboardApi, DashboardApiError } from "../data/api.js";
import { ProjectEventBridge } from "../data/project-events.js";
import { queryKeys } from "../data/query-keys.js";

export type LiveStatus = "connecting" | "live" | "offline" | "reconnecting" | "unavailable";

export function useProjects() {
  return useQuery({ queryKey: queryKeys.projects, queryFn: dashboardApi.projects });
}

export function useProjectHome(project: string | null) {
  const enabled = Boolean(project);
  const queue = useQuery({ queryKey: queryKeys.queue(project ?? ""), queryFn: () => dashboardApi.queue(project!), enabled });
  const agents = useQuery({ queryKey: queryKeys.agents(project ?? ""), queryFn: () => dashboardApi.agents(project!), enabled });
  return { queue, agents };
}

export function useProjectEvents(project: string | null): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>(project ? "connecting" : "offline");
  useEffect(() => {
    const bridge = new ProjectEventBridge({
      invalidateProject: (id) => client.invalidateQueries({ queryKey: queryKeys.project(id) }),
      reload: () => window.location.reload(),
      probeProject: async (id) => {
        try {
          await dashboardApi.health(id);
          return "available";
        } catch (error) {
          if (error instanceof DashboardApiError && error.status === 401) return "unauthorized";
          if (error instanceof DashboardApiError && error.status === 404) return "missing";
          throw error;
        }
      },
      onStatus: setStatus,
    });
    bridge.setProject(project);
    return () => bridge.close();
  }, [client, project]);
  return status;
}
