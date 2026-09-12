import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ImageBudget } from "@oh-my-pi/pi-tui";
import { setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";

// 2x2 red PNG used by the Kitty transmit path.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";

function pngImage(): ImageContent {
	return { type: "image", data: TINY_PNG, mimeType: "image/png" };
}

beforeAll(async () => {
	await initTheme(false);
});

describe("UserMessageComponent image preview", () => {
	it("renders a Kitty preview row after the bubble text", () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			const budget = new ImageBudget(8);
			const component = new UserMessageComponent("see [Image #1]", false, undefined, undefined, {
				images: [pngImage()],
				budget,
				visible: true,
			});
			expect(component.render(80).join("\n")).toContain("\x1b_Ga=p,U=1");
			expect(budget.takeTransmits().length).toBeGreaterThan(0);

			const withoutPreview = new UserMessageComponent("see [Image #1]");
			expect(withoutPreview.render(80).join("\n")).not.toContain("\x1b_G");
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});

	it("keeps markers as the only representation without a protocol or when hidden", () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			mutable.imageProtocol = null;
			const noProtocolBudget = new ImageBudget(8);
			const noProtocolWithPreview = new UserMessageComponent("see [Image #1]", false, undefined, undefined, {
				images: [pngImage()],
				budget: noProtocolBudget,
				visible: true,
			});
			const noProtocolWithoutPreview = new UserMessageComponent("see [Image #1]");
			expect(noProtocolWithPreview.render(80)).toEqual(noProtocolWithoutPreview.render(80));
			expect(noProtocolBudget.hasPendingTransmits()).toBe(false);

			mutable.imageProtocol = ImageProtocol.Kitty;
			const hiddenBudget = new ImageBudget(8);
			const hiddenWithPreview = new UserMessageComponent("see [Image #1]", false, undefined, undefined, {
				images: [pngImage()],
				budget: hiddenBudget,
				visible: false,
			});
			const hiddenWithoutPreview = new UserMessageComponent("see [Image #1]");
			expect(hiddenWithPreview.render(80)).toEqual(hiddenWithoutPreview.render(80));
			expect(hiddenBudget.hasPendingTransmits()).toBe(false);
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});

	it("renders nothing for synthetic inputs", () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			const budget = new ImageBudget(8);
			const withPreview = new UserMessageComponent("see [Image #1]", true, undefined, undefined, {
				images: [pngImage()],
				budget,
				visible: true,
			});
			const withoutPreview = new UserMessageComponent("see [Image #1]", true);
			expect(withPreview.render(80)).toEqual(withoutPreview.render(80));
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});

	it("defers a non-PNG preview until the Kitty conversion lands", async () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			const jpeg = await new Bun.Image(Buffer.from(TINY_PNG, "base64")).jpeg().toBase64();
			const budget = new ImageBudget(8);
			const repaint = Promise.withResolvers<void>();
			const component = new UserMessageComponent("see [Image #1]", false, undefined, undefined, {
				images: [{ type: "image", data: jpeg, mimeType: "image/jpeg" }],
				budget,
				visible: true,
				onImageUpdate: () => repaint.resolve(),
			});

			expect(component.render(80).join("\n")).not.toContain("\x1b_Ga=p,U=1");
			expect(budget.hasPendingTransmits()).toBe(false);
			await repaint.promise;
			expect(component.render(80).join("\n")).toContain("\x1b_Ga=p,U=1");
			const transmits = budget.takeTransmits();
			expect(transmits).toHaveLength(1);
			const payload = transmits[0]!.slice(transmits[0]!.indexOf(";") + 1);
			expect(payload.startsWith("iVBOR")).toBe(true);
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});
});
