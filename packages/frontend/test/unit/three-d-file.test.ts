/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from "vitest";
import {
	getThreeDFileFormat,
	isGaussianSplatFormat,
	isThreeDFile,
} from "@/utility/three-d-file.js";

describe("three-d-file", () => {
	test.each([
		["scene.FBX", "application/octet-stream", "fbx"],
		["scene", "application/x-ft-fbx", "fbx"],
		["scene.glb", "model/gltf-binary", "glb"],
		["capture.ply", "application/octet-stream", "ply"],
		["capture.sog", "application/zip", "sog"],
	])("detects %s as %s", (name, type, expected) => {
		expect(getThreeDFileFormat({ name, type })).toBe(expected);
	});

	test("does not classify unrelated files", () => {
		expect(
			isThreeDFile({ name: "document.pdf", type: "application/pdf" }),
		).toBe(false);
	});

	test("distinguishes Gaussian splats from polygon models", () => {
		expect(isGaussianSplatFormat("spz")).toBe(true);
		expect(isGaussianSplatFormat("fbx")).toBe(false);
	});
});
