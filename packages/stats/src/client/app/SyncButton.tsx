import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { sync } from "../api";
import { t, tp } from "../locale/catalog";
import { useLocale } from "../useLocale";

/**
 * Status stored as structured data so locale changes (or future re-renders
 * without an HTTP round-trip) re-evaluate the user-visible copy via t()/tp()
 * at render time. Storing the already-localized message in state would freeze
 * it to whichever locale was active at sync time.
 */
type SyncStatus = { type: "success"; processed: number } | { type: "error"; rawError: string };

export interface SyncButtonProps {
	onSyncStart?: () => void;
	onSyncComplete?: (result: {
		success: boolean;
		data?: { processed: number; files: number; totalMessages: number };
		error?: string;
	}) => void;
	className?: string;
}

export function SyncButton({ onSyncStart, onSyncComplete, className = "" }: SyncButtonProps) {
	// Subscribe so success/error copy refreshes when the user flips locale.
	useLocale();
	const [syncing, setSyncing] = useState(false);
	const [status, setStatus] = useState<SyncStatus | null>(null);

	const handleSync = async () => {
		if (syncing) return;

		setSyncing(true);
		setStatus(null);
		if (onSyncStart) {
			onSyncStart();
		}

		try {
			const data = await sync();
			const result = {
				processed: typeof data?.processed === "number" ? data.processed : 0,
				files: typeof data?.files === "number" ? data.files : 0,
				totalMessages: typeof data?.totalMessages === "number" ? data.totalMessages : 0,
			};
			setStatus({ type: "success", processed: result.processed });
			if (onSyncComplete) {
				onSyncComplete({ success: true, data: result });
			}
		} catch (err) {
			const rawError = err instanceof Error ? err.message : String(err);
			setStatus({ type: "error", rawError });
			if (onSyncComplete) {
				onSyncComplete({ success: false, error: rawError });
			}
		} finally {
			setSyncing(false);
		}
	};

	return (
		<div className={`stats-sync-container ${className}`}>
			{status && (
				<span className="stats-sync-status-msg" data-type={status.type}>
					{status.type === "success"
						? tp("syncButton.success.singular", "syncButton.success.plural", status.processed, {
								n: status.processed,
							})
						: t("syncButton.error", { message: status.rawError })}
				</span>
			)}
			<button
				type="button"
				onClick={handleSync}
				disabled={syncing}
				className="stats-button stats-button-primary stats-sync-btn"
				aria-busy={syncing}
			>
				<RefreshCw size={14} className={`stats-sync-icon ${syncing ? "stats-spin" : ""}`} />
				{syncing ? t("syncButton.syncing") : t("syncButton.idle")}
			</button>
		</div>
	);
}
