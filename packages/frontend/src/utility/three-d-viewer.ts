/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type * as Misskey from "misskey-js";
import { isGaussianSplatFormat } from "@/utility/three-d-file.js";
import type { ThreeDFileFormat } from "@/utility/three-d-file.js";

export type ThreeDViewer = {
	dispose: () => void;
};

type ThreeDViewerOptions = {
	canvas: HTMLCanvasElement;
	file: Pick<Misskey.entities.DriveFile, "name" | "url">;
	format: ThreeDFileFormat;
	signal?: AbortSignal;
};

type LoadedModel = {
	object: THREE.Object3D;
	animations: THREE.AnimationClip[];
};

export async function createThreeDViewer(
	options: ThreeDViewerOptions,
): Promise<ThreeDViewer> {
	const { canvas, file, format, signal } = options;
	const renderer = new THREE.WebGLRenderer({
		canvas,
		alpha: true,
		antialias: !isGaussianSplatFormat(format),
		powerPreference: "high-performance",
	});
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1;
	renderer.setClearColor(0x000000, 0);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.screenSpacePanning = true;

	const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2.5);
	const directionalLight = new THREE.DirectionalLight(0xffffff, 3);
	directionalLight.position.set(3, 5, 4);
	scene.add(hemisphereLight, directionalLight);

	let disposed = false;
	let frameId: number | null = null;
	let model: THREE.Object3D | null = null;
	let mixer: THREE.AnimationMixer | null = null;
	let splatMesh: SplatMesh | null = null;
	let sparkRenderer: SparkRenderer | null = null;
	let lastFrameTime: number | null = null;

	const resize = () => {
		const width = Math.max(1, canvas.clientWidth);
		const height = Math.max(1, canvas.clientHeight);
		if (
			canvas.width !== Math.round(width * renderer.getPixelRatio()) ||
			canvas.height !== Math.round(height * renderer.getPixelRatio())
		) {
			renderer.setSize(width, height, false);
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
		}
	};
	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(canvas);
	resize();

	const animate = (time: number) => {
		if (disposed) return;
		frameId = window.requestAnimationFrame(animate);
		const delta = lastFrameTime == null ? 0 : Math.min((time - lastFrameTime) / 1000, 0.1);
		lastFrameTime = time;
		mixer?.update(delta);
		controls.update();
		resize();
		renderer.render(scene, camera);
	};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		if (frameId != null) window.cancelAnimationFrame(frameId);
		resizeObserver.disconnect();
		controls.dispose();
		mixer?.stopAllAction();
		if (model != null) disposeObject(model);
		splatMesh?.dispose();
		sparkRenderer?.dispose();
		renderer.dispose();
	};

	try {
		const response = await window.fetch(file.url, {
			credentials: "same-origin",
			signal,
		});
		if (!response.ok) {
			throw new Error(`Failed to fetch 3D file: ${response.status}`);
		}
		const fileBytes = await response.arrayBuffer();
		if (signal?.aborted) throw signal.reason;

		let bounds: THREE.Box3;
		if (isGaussianSplatFormat(format)) {
			sparkRenderer = new SparkRenderer({ renderer });
			scene.add(sparkRenderer);

			splatMesh = new SplatMesh({
				fileBytes,
				fileName: file.name,
			});
			await splatMesh.initialized;
			if (signal?.aborted) throw signal.reason;
			scene.add(splatMesh);
			bounds = splatMesh.getBoundingBox();
		} else {
			const loaded = await loadPolygonModel(format, fileBytes, file.url);
			if (signal?.aborted) throw signal.reason;
			model = loaded.object;
			scene.add(model);
			model.updateWorldMatrix(true, true);
			bounds = new THREE.Box3().setFromObject(model);

			if (loaded.animations.length > 0) {
				mixer = new THREE.AnimationMixer(model);
				for (const animation of loaded.animations) {
					mixer.clipAction(animation).play();
				}
			}
		}

		fitCamera(camera, controls, bounds);
		frameId = window.requestAnimationFrame(animate);
		return { dispose };
	} catch (error) {
		dispose();
		throw error;
	}
}

async function loadPolygonModel(
	format: ThreeDFileFormat,
	fileBytes: ArrayBuffer,
	fileUrl: string,
): Promise<LoadedModel> {
	const resourcePath = getResourcePath(fileUrl);

	switch (format) {
		case "fbx": {
			const object = new FBXLoader().parse(fileBytes, resourcePath);
			return { object, animations: object.animations };
		}
		case "glb":
		case "gltf": {
			const data =
				format === "gltf" ? new TextDecoder().decode(fileBytes) : fileBytes;
			const gltf = await new GLTFLoader().parseAsync(data, resourcePath);
			return { object: gltf.scene, animations: gltf.animations };
		}
		case "obj": {
			const object = new OBJLoader().parse(new TextDecoder().decode(fileBytes));
			return { object, animations: [] };
		}
		case "stl": {
			const geometry = new STLLoader().parse(fileBytes);
			geometry.computeVertexNormals();
			const material = new THREE.MeshStandardMaterial({
				color: 0xb8c4d4,
				roughness: 0.7,
				metalness: 0.05,
			});
			return { object: new THREE.Mesh(geometry, material), animations: [] };
		}
		default:
			throw new Error(`Unsupported polygon model format: ${format}`);
	}
}

function getResourcePath(fileUrl: string): string {
	try {
		const url = new URL(fileUrl, window.location.href);
		url.hash = "";
		url.search = "";
		url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
		return url.href;
	} catch {
		return "";
	}
}

function fitCamera(
	camera: THREE.PerspectiveCamera,
	controls: OrbitControls,
	bounds: THREE.Box3,
): void {
	const safeBounds = bounds.isEmpty()
		? new THREE.Box3(new THREE.Vector3(-0.5), new THREE.Vector3(0.5))
		: bounds;
	const center = safeBounds.getCenter(new THREE.Vector3());
	const size = safeBounds.getSize(new THREE.Vector3());
	const radius = Math.max(size.length() / 2, 0.01);
	const fov = THREE.MathUtils.degToRad(camera.fov);
	const distance = Math.max(radius / Math.tan(fov / 2), 0.1) * 1.25;

	camera.position
		.copy(center)
		.add(new THREE.Vector3(0.8, 0.55, 1).normalize().multiplyScalar(distance));
	camera.near = Math.max(distance / 1000, 0.0001);
	camera.far = Math.max(distance * 1000, 100);
	camera.updateProjectionMatrix();
	controls.target.copy(center);
	controls.minDistance = Math.max(radius * 0.01, 0.0001);
	controls.maxDistance = Math.max(radius * 100, 100);
	controls.update();
}

function disposeObject(root: THREE.Object3D): void {
	root.traverse((object) => {
		if (!(object instanceof THREE.Mesh)) return;
		object.geometry.dispose();
		const materials = Array.isArray(object.material)
			? object.material
			: [object.material];
		for (const material of materials) {
			for (const value of Object.values(material)) {
				if (value instanceof THREE.Texture) value.dispose();
			}
			material.dispose();
		}
	});
}
