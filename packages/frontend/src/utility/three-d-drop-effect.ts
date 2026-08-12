/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Matter from 'matter-js';
import * as THREE from 'three';
import { prefer } from '@/preferences.js';

export type ThreeDDropOrigin = {
	x: number;
	y: number;
};

type FallingPreview = {
	body: Matter.Body;
	geometry: THREE.PlaneGeometry;
	material: THREE.MeshBasicMaterial;
	mesh: THREE.Mesh;
	texture: THREE.CanvasTexture;
	visualOffset: Matter.Vector;
};

const COLLIDER_COLUMNS = 10;
const COLLIDER_ROWS = 10;
const ALPHA_THRESHOLD = 24;
const CELL_COVERAGE_THRESHOLD = 0.04;
const MAX_PREVIEWS = 64;

let activeEffect: ThreeDDropEffect | null = null;

export function dropThreeDPreview(snapshot: HTMLCanvasElement, origin: ThreeDDropOrigin): void {
	activeEffect ??= new ThreeDDropEffect();
	activeEffect.drop(snapshot, origin);
}

class ThreeDDropEffect {
	private readonly canvas: HTMLCanvasElement;
	private readonly camera: THREE.OrthographicCamera;
	private readonly engine: Matter.Engine;
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly previews: FallingPreview[] = [];
	private boundaries: Matter.Body[] = [];
	private frameId: number | null = null;
	private lastFrameTime: number | null = null;

	constructor() {
		this.canvas = window.document.createElement('canvas');
		this.canvas.ariaHidden = 'true';
		this.canvas.dataset.threeDDropEffect = 'true';
		Object.assign(this.canvas.style, {
			position: 'fixed',
			inset: '0',
			width: '100%',
			height: '100%',
			pointerEvents: 'none',
			zIndex: '2147483646',
		});
		window.document.body.append(this.canvas);

		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			alpha: true,
			antialias: true,
			powerPreference: 'low-power',
		});
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

		this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 1000);
		this.camera.position.z = 100;

		this.engine = Matter.Engine.create({ enableSleeping: true });
		this.engine.gravity.scale = 0.0018;

		this.resize();
		window.addEventListener('resize', this.resize);
		window.addEventListener('pagehide', this.dispose, { once: true });
	}

	public drop(snapshot: HTMLCanvasElement, origin: ThreeDDropOrigin): void {
		if (this.previews.length >= MAX_PREVIEWS) return;

		const aspect = snapshot.width / Math.max(snapshot.height, 1);
		const width = Math.min(180, Math.max(108, window.innerWidth * 0.16));
		const height = Math.min(150, Math.max(64, width / aspect));
		const startX = Math.min(window.innerWidth - width / 2, Math.max(width / 2, origin.x));
		const startY = Math.min(window.innerHeight - height / 2, Math.max(-height / 2, origin.y));
		const colliderParts = createAlphaColliderParts(snapshot, startX, startY, width, height);
		const body = Matter.Body.create({
			parts: colliderParts,
			friction: 0.55,
			frictionAir: 0.008,
			restitution: 0.42,
			sleepThreshold: 45,
		});
		const visualOffset = Matter.Vector.sub({ x: startX, y: startY }, body.position);
		Matter.Composite.add(this.engine.world, body);

		const texture = new THREE.CanvasTexture(snapshot);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.flipY = false;
		texture.minFilter = THREE.LinearFilter;
		texture.generateMipmaps = false;
		const material = new THREE.MeshBasicMaterial({
			depthWrite: false,
			map: texture,
			side: THREE.DoubleSide,
			transparent: true,
		});
		const geometry = new THREE.PlaneGeometry(width, height);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.position.set(body.position.x, body.position.y, this.previews.length * 0.1);
		this.scene.add(mesh);

		const preview: FallingPreview = {
			body,
			geometry,
			material,
			mesh,
			texture,
			visualOffset,
		};
		this.previews.push(preview);
		this.canvas.dataset.dropCount = String(this.previews.length);
		this.canvas.dataset.lastColliderParts = String(colliderParts.length);

		if (prefer.s.animation) {
			Matter.Body.setVelocity(body, {
				x: (Math.random() - 0.5) * 12,
				y: Math.random() * 2,
			});
			Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.18);
		} else {
			this.settleWithoutAnimation(body);
			this.syncPreview(preview);
			this.renderer.render(this.scene, this.camera);
		}

		if (prefer.s.animation && this.frameId == null) {
			this.lastFrameTime = null;
			this.frameId = window.requestAnimationFrame(this.update);
		}
	}

	private readonly update = (time: number): void => {
		if (!prefer.s.animation) {
			for (const preview of this.previews) {
				if (!preview.body.isStatic) this.settleWithoutAnimation(preview.body);
				this.syncPreview(preview);
			}
			this.renderer.render(this.scene, this.camera);
			this.frameId = null;
			this.lastFrameTime = null;
			return;
		}

		const deltaMs = this.lastFrameTime == null ? 1000 / 60 : Math.min(time - this.lastFrameTime, 1000 / 15);
		this.lastFrameTime = time;
		let remainingDeltaMs = deltaMs;
		while (remainingDeltaMs > 0) {
			const physicsStepMs = Math.min(remainingDeltaMs, 1000 / 60);
			Matter.Engine.update(this.engine, physicsStepMs);
			remainingDeltaMs -= physicsStepMs;
		}

		for (const preview of this.previews) this.syncPreview(preview);

		this.renderer.render(this.scene, this.camera);
		if (this.previews.every((preview) => preview.body.isSleeping || preview.body.isStatic)) {
			this.frameId = null;
			this.lastFrameTime = null;
			return;
		}
		this.frameId = window.requestAnimationFrame(this.update);
	};

	private syncPreview(preview: FallingPreview): void {
		const rotatedOffset = Matter.Vector.rotate(preview.visualOffset, preview.body.angle);
		preview.mesh.position.x = preview.body.position.x + rotatedOffset.x;
		preview.mesh.position.y = preview.body.position.y + rotatedOffset.y;
		preview.mesh.rotation.z = preview.body.angle;
	}

	private settleWithoutAnimation(body: Matter.Body): void {
		const bottomOffset = window.innerHeight - 4 - body.bounds.max.y;
		Matter.Body.translate(body, { x: 0, y: bottomOffset });
		Matter.Body.setVelocity(body, { x: 0, y: 0 });
		Matter.Body.setAngularVelocity(body, 0);
		Matter.Body.setStatic(body, true);
	}

	private readonly resize = (): void => {
		const width = Math.max(1, window.innerWidth);
		const height = Math.max(1, window.innerHeight);
		const previousHeight = this.camera.bottom;
		this.renderer.setSize(width, height, false);
		this.camera.left = 0;
		this.camera.right = width;
		this.camera.top = 0;
		this.camera.bottom = height;
		this.camera.updateProjectionMatrix();
		if (previousHeight > 1 && previousHeight !== height) {
			for (const preview of this.previews) {
				Matter.Body.translate(preview.body, { x: 0, y: height - previousHeight });
				this.syncPreview(preview);
			}
		}

		Matter.Composite.remove(this.engine.world, this.boundaries);
		const wallThickness = 100;
		this.boundaries = [
			Matter.Bodies.rectangle(width / 2, height + wallThickness / 2, width + wallThickness * 2, wallThickness, { isStatic: true }),
			Matter.Bodies.rectangle(-wallThickness / 2, height / 2, wallThickness, height * 2, { isStatic: true }),
			Matter.Bodies.rectangle(width + wallThickness / 2, height / 2, wallThickness, height * 2, { isStatic: true }),
		];
		Matter.Composite.add(this.engine.world, this.boundaries);
		this.renderer.render(this.scene, this.camera);
	};

	private readonly dispose = (): void => {
		if (this.frameId != null) window.cancelAnimationFrame(this.frameId);
		this.frameId = null;
		window.removeEventListener('resize', this.resize);
		window.removeEventListener('pagehide', this.dispose);
		for (const preview of this.previews) {
			preview.geometry.dispose();
			preview.material.dispose();
			preview.texture.dispose();
		}
		this.previews.length = 0;
		Matter.Engine.clear(this.engine);
		this.renderer.dispose();
		this.canvas.remove();
		activeEffect = null;
	};
}

function createAlphaColliderParts(
	snapshot: HTMLCanvasElement,
	centerX: number,
	centerY: number,
	width: number,
	height: number,
): Matter.Body[] {
	const context = snapshot.getContext('2d', { willReadFrequently: true });
	if (context == null) return [createColliderRectangle(centerX, centerY, width, height)];

	let pixels: Uint8ClampedArray;
	try {
		pixels = context.getImageData(0, 0, snapshot.width, snapshot.height).data;
	} catch {
		return [createColliderRectangle(centerX, centerY, width, height)];
	}

	const occupied = Array.from({ length: COLLIDER_ROWS }, () => Array<boolean>(COLLIDER_COLUMNS).fill(false));
	for (let row = 0; row < COLLIDER_ROWS; row++) {
		const sourceTop = Math.floor(row * snapshot.height / COLLIDER_ROWS);
		const sourceBottom = Math.max(sourceTop + 1, Math.floor((row + 1) * snapshot.height / COLLIDER_ROWS));
		for (let column = 0; column < COLLIDER_COLUMNS; column++) {
			const sourceLeft = Math.floor(column * snapshot.width / COLLIDER_COLUMNS);
			const sourceRight = Math.max(sourceLeft + 1, Math.floor((column + 1) * snapshot.width / COLLIDER_COLUMNS));
			let opaquePixels = 0;
			let sampledPixels = 0;
			const sampleStep = Math.max(1, Math.floor(Math.min(sourceRight - sourceLeft, sourceBottom - sourceTop) / 6));
			for (let y = sourceTop; y < sourceBottom; y += sampleStep) {
				for (let x = sourceLeft; x < sourceRight; x += sampleStep) {
					sampledPixels++;
					if (pixels[(y * snapshot.width + x) * 4 + 3] >= ALPHA_THRESHOLD) opaquePixels++;
				}
			}
			occupied[row][column] = opaquePixels / Math.max(sampledPixels, 1) >= CELL_COVERAGE_THRESHOLD;
		}
	}

	const rectangles: Array<{ left: number; right: number; top: number; bottom: number }> = [];
	for (let row = 0; row < COLLIDER_ROWS; row++) {
		let column = 0;
		while (column < COLLIDER_COLUMNS) {
			if (!occupied[row][column]) {
				column++;
				continue;
			}
			const left = column;
			while (column + 1 < COLLIDER_COLUMNS && occupied[row][column + 1]) column++;
			const right = column + 1;
			const previous = rectangles.find((rectangle) => rectangle.left === left && rectangle.right === right && rectangle.bottom === row);
			if (previous == null) {
				rectangles.push({ left, right, top: row, bottom: row + 1 });
			} else {
				previous.bottom = row + 1;
			}
			column++;
		}
	}

	if (rectangles.length === 0) return [createColliderRectangle(centerX, centerY, width, height)];
	return rectangles.map((rectangle) => {
		const partWidth = (rectangle.right - rectangle.left) * width / COLLIDER_COLUMNS;
		const partHeight = (rectangle.bottom - rectangle.top) * height / COLLIDER_ROWS;
		const partX = centerX - width / 2 + (rectangle.left + rectangle.right) * width / COLLIDER_COLUMNS / 2;
		const partY = centerY - height / 2 + (rectangle.top + rectangle.bottom) * height / COLLIDER_ROWS / 2;
		return createColliderRectangle(partX, partY, partWidth, partHeight);
	});
}

function createColliderRectangle(x: number, y: number, width: number, height: number): Matter.Body {
	return Matter.Bodies.rectangle(x, y, width, height, {
		chamfer: { radius: Math.min(width, height, 8) / 3 },
		friction: 0.55,
		restitution: 0.42,
	});
}
