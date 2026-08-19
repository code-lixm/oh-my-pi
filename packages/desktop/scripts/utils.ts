export type Channel = "dev" | "beta" | "prod";

export function resolveChannel(raw = process.env.OMP_CHANNEL): Channel {
	if (raw === "latest") return "prod";
	if (raw === "dev" || raw === "beta" || raw === "prod") return raw;
	return "dev";
}
