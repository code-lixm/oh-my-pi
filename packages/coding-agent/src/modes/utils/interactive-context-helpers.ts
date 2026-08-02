/**
 * Small helpers over {@link InteractiveModeContext} shared between
 * {@link UiHelpers} and the input/event controllers, so the live chat surfaces
 * construct components and reset editor state identically.
 */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { AssistantMessageComponent } from "../components/assistant-message";
import { openImageInSystemViewer } from "../image-references";
import type { InteractiveModeContext } from "../types";

export function openRichContentLink(ctx: InteractiveModeContext, href: string): void {
	try {
		ctx.openInBrowser(href);
	} catch (error) {
		logger.warn("Failed to open transcript link", {
			href,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function openRichContentImage(ctx: InteractiveModeContext, image: ImageContent): void {
	const sessionManager = ctx.viewSession.sessionManager;
	openImageInSystemViewer(image, sessionManager.putBlobSync.bind(sessionManager), path => ctx.openInBrowser(path));
}

/**
 * Construct an {@link AssistantMessageComponent} wired to the live context's
 * thinking/image settings. `message` is omitted for the streaming placeholder
 * component and supplied when rendering a persisted turn.
 */
export function createAssistantMessageComponent(
	ctx: InteractiveModeContext,
	message?: AssistantMessage,
): AssistantMessageComponent {
	const component = new AssistantMessageComponent(
		message,
		ctx.effectiveHideThinkingBlock,
		() => ctx.ui.requestRender(),
		ctx.viewSession.extensionRunner?.getAssistantThinkingRenderers(),
		ctx.ui.imageBudget,
		ctx.proseOnlyThinking,
		{
			openLink: href => openRichContentLink(ctx, href),
			openImage: image => openRichContentImage(ctx, image),
		},
	);
	component.setImagesVisible(ctx.settings.get("terminal.showImages"));
	component.setExpanded(ctx.toolOutputExpanded);
	return component;
}
