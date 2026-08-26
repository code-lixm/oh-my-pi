import { truncateToWidth, visibleWidth } from "../../utils";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

/**
 * Legacy horizontal-rule composer used by existing normal-screen editor hosts.
 * It preserves the prior editor chrome while participating in the shared
 * ComposerStyle registry.
 */
export const horizontalComposerStyle: ComposerStyle = {
	id: "horizontal",
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "top-rule-chip",
	bottomBar: "none",
	bottomBarGap: false,
	defaultPromptGutter: undefined,

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(): number {
		return 0;
	},

	renderTop(ctx: ComposerChromeContext): string {
		if (ctx.width <= 0) return "";
		const availableWidth = Math.max(0, ctx.width - 2);
		const content = ctx.topBorder ? truncateToWidth(ctx.topBorder.content, availableWidth) : "";
		const contentWidth = visibleWidth(content);
		return (
			ctx.borderColor(ctx.box.horizontal) +
			content +
			ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, ctx.width - contentWidth - 1)))
		);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		return ctx.borderColor(ctx.box.horizontal.repeat(ctx.width));
	},
};
