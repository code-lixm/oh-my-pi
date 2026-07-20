import { Activity, AlertCircle, Coins, Cpu, Folder, LayoutDashboard, Smile, TrendingUp, Wrench } from "lucide-react";
import type React from "react";

export type DashboardSection =
	| "overview"
	| "requests"
	| "errors"
	| "models"
	| "tools"
	| "costs"
	| "behavior"
	| "projects"
	| "gain";

export interface DashboardRoute {
	id: DashboardSection;
	icon: React.ComponentType<{ size?: number; className?: string }>;
}

export const routes: DashboardRoute[] = [
	{ id: "overview", icon: LayoutDashboard },
	{ id: "requests", icon: Activity },
	{ id: "errors", icon: AlertCircle },
	{ id: "models", icon: Cpu },
	{ id: "tools", icon: Wrench },
	{ id: "costs", icon: Coins },
	{ id: "behavior", icon: Smile },
	{ id: "projects", icon: Folder },
	{ id: "gain", icon: TrendingUp },
];
