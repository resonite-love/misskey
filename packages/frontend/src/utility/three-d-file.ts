/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as Misskey from "misskey-js";

export const THREE_D_FILE_FORMATS = [
	"fbx",
	"glb",
	"gltf",
	"obj",
	"stl",
	"ply",
	"spz",
	"splat",
	"ksplat",
	"sog",
	"rad",
] as const;

export type ThreeDFileFormat = (typeof THREE_D_FILE_FORMATS)[number];

const extensionToFormat = new Map<string, ThreeDFileFormat>(
	THREE_D_FILE_FORMATS.map((format) => [format, format]),
);

const mimeToFormat = new Map<string, ThreeDFileFormat>([
	["application/x-ft-fbx", "fbx"],
	["model/fbx", "fbx"],
	["model/gltf-binary", "glb"],
	["model/gltf+json", "gltf"],
	["model/obj", "obj"],
	["model/stl", "stl"],
	["application/sla", "stl"],
]);

export function getThreeDFileFormat(
	file: Pick<Misskey.entities.DriveFile, "name" | "type">,
): ThreeDFileFormat | null {
	const extension = file.name
		.split(/[?#]/, 1)[0]
		.split(".")
		.pop()
		?.toLowerCase();
	if (extension != null) {
		const format = extensionToFormat.get(extension);
		if (format != null) return format;
	}

	return mimeToFormat.get(file.type.toLowerCase()) ?? null;
}

export function isThreeDFile(
	file: Pick<Misskey.entities.DriveFile, "name" | "type">,
): boolean {
	return getThreeDFileFormat(file) != null;
}

export function isGaussianSplatFormat(format: ThreeDFileFormat): boolean {
	return (
		format === "ply" ||
		format === "spz" ||
		format === "splat" ||
		format === "ksplat" ||
		format === "sog" ||
		format === "rad"
	);
}
